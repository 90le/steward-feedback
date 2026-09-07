// 独立验收测试：incoming-webhooks GitHub 强制签名校验原型
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
assert.ok(CANDIDATE_DIR, "CANDIDATE_DIR must be set");

let child;
let baseUrl;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url + "/api/health");
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become ready in time");
}

before(async () => {
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(CANDIDATE_DIR, "server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: "/tmp"
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForReady(baseUrl);
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (!child.killed) child.kill("SIGKILL");
  }
});

async function api(path, { method = "GET", actor, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (actor) headers["X-User-Id"] = actor;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text };
}

function sign(secret, payload) {
  return "sha256=" + createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

// ============================================================
// 1) 主流程：AC-2/AC-3：开启强制签名 + 设置 secret + 正确签名 → accepted
// ============================================================
test("主流程：开启签名+设置secret+正确签名的模拟投递被受理", async () => {
  // 使用 wh_prod_infra（初始 require_signature=false，无 secret）
  const enable = await api("/api/webhooks/wh_prod_infra/signature", {
    method: "PUT", actor: "admin_alice", body: { require_signature: true }
  });
  assert.equal(enable.status, 200, "admin 开启开关应 200");
  assert.equal(enable.body.ok, true);
  assert.equal(enable.body.webhook.require_signature, true);
  assert.equal(enable.body.webhook.has_secret, false, "尚未设置 secret");
  // secret 原文不得出现在响应
  assert.ok(!("secret" in enable.body.webhook), "read 接口不应包含 secret 字段");

  const secretVal = "unit-test-secret-XYZ";
  const setSec = await api("/api/webhooks/wh_prod_infra/secret", {
    method: "PUT", actor: "admin_alice", body: { secret: secretVal }
  });
  assert.equal(setSec.status, 200);
  assert.equal(setSec.body.webhook.has_secret, true);
  // AC-8：写响应不应回显 secret 原文
  assert.ok(!setSec.text.includes(secretVal), "写 secret 的响应不得回显原文");

  // 列表接口也不应包含 secret 原文
  const list = await api("/api/webhooks");
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(secretVal), "GET 列表不得包含 secret 原文");
  const item = list.body.webhooks.find((w) => w.id === "wh_prod_infra");
  assert.equal(item.require_signature, true);
  assert.equal(item.has_secret, true);
  assert.ok(!("secret" in item));

  // 用正确 secret 生成签名并模拟投递
  const payload = JSON.stringify({ zen: "test payload", n: 42 });
  const sig = sign(secretVal, payload);
  const deliver = await api("/api/simulate-delivery", {
    method: "POST", actor: "admin_alice",
    body: {
      webhook_id: "wh_prod_infra",
      token: "tkn_prod_infra_0001",
      event: "push",
      delivery_id: "d-main-1",
      signature: sig,
      body: payload
    }
  });
  assert.equal(deliver.status, 200);
  assert.equal(deliver.body.accepted, true, "合法签名请求应被受理");
  assert.equal(deliver.body.reason, "");

  // 投递记录应包含这次受理
  const dels = await api("/api/deliveries");
  assert.equal(dels.status, 200);
  const rec = dels.body.deliveries.find((d) => d.delivery_id === "d-main-1");
  assert.ok(rec, "投递记录中应能找到刚才那条");
  assert.equal(rec.accepted, true);
  assert.equal(rec.webhook_id, "wh_prod_infra");
});

// ============================================================
// 2) 身份边界：viewer/anonymous 不能修改开关或 secret，操作前后状态不变
// ============================================================
test("服务端身份校验：非 admin 不得修改开关或 secret，也不能通过前端 disabled 伪装", async () => {
  // 读取初始状态
  const before = await api("/api/webhooks");
  const targetBefore = before.body.webhooks.find((w) => w.id === "wh_dev_sandbox");
  const initialRequire = targetBefore.require_signature;
  const initialHasSecret = targetBefore.has_secret;

  // viewer_carol 尝试改开关
  const asViewer = await api("/api/webhooks/wh_dev_sandbox/signature", {
    method: "PUT", actor: "viewer_carol", body: { require_signature: !initialRequire }
  });
  assert.equal(asViewer.status, 403, "viewer 应被服务端拒绝");
  assert.equal(asViewer.body.error, "forbidden");

  // anonymous 尝试改 secret
  const asAnon = await api("/api/webhooks/wh_dev_sandbox/secret", {
    method: "PUT", actor: "anonymous", body: { secret: "hacker" }
  });
  assert.equal(asAnon.status, 403);

  // 无身份头
  const noHeader = await fetch(baseUrl + "/api/webhooks/wh_dev_sandbox/secret", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: "hacker2" })
  });
  assert.equal(noHeader.status, 403, "未带身份头视作 anonymous，应 403");

  // 状态不能被上面任何一次调用改动
  const after = await api("/api/webhooks");
  const targetAfter = after.body.webhooks.find((w) => w.id === "wh_dev_sandbox");
  assert.equal(targetAfter.require_signature, initialRequire, "开关未被非 admin 修改");
  assert.equal(targetAfter.has_secret, initialHasSecret, "secret 未被非 admin 修改");

  // 404 边界：未知 webhook
  const unknown = await api("/api/webhooks/does_not_exist/signature", {
    method: "PUT", actor: "admin_alice", body: { require_signature: true }
  });
  assert.equal(unknown.status, 404);
});

// ============================================================
// 3) 失败保持状态：签名各类失败路径都被拒收，deliveries 中原因分明
// ============================================================
test("签名失败与 URL token 失败：全部拒收，reason 与业务边界一致", async () => {
  // 使用 wh_sec_audit：初始 require_signature=true, secret="s3cret-audit-A"
  const list = await api("/api/webhooks");
  const w = list.body.webhooks.find((x) => x.id === "wh_sec_audit");
  assert.equal(w.require_signature, true);
  assert.equal(w.has_secret, true);

  const goodSecret = "s3cret-audit-A";
  const payload = JSON.stringify({ action: "opened", number: 1 });

  // 3.1 signature_missing：未携带 signature
  const missing = await api("/api/simulate-delivery", {
    method: "POST",
    body: {
      webhook_id: "wh_sec_audit",
      token: "tkn_sec_audit_0002",
      event: "pull_request",
      delivery_id: "d-miss",
      body: payload
      // signature 缺省
    }
  });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.accepted, false);
  assert.equal(missing.body.reason, "signature_missing");

  // 3.2 signature_mismatch：使用错误 secret 签名
  const wrongSig = sign("wrong-secret", payload);
  const mismatch = await api("/api/simulate-delivery", {
    method: "POST",
    body: {
      webhook_id: "wh_sec_audit",
      token: "tkn_sec_audit_0002",
      event: "pull_request",
      delivery_id: "d-mismatch",
      signature: wrongSig,
      body: payload
    }
  });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.body.accepted, false);
  assert.equal(mismatch.body.reason, "signature_mismatch");

  // 3.3 篡改请求体：签名针对原 payload，但 body 被改
  const goodSig = sign(goodSecret, payload);
  const tampered = await api("/api/simulate-delivery", {
    method: "POST",
    body: {
      webhook_id: "wh_sec_audit",
      token: "tkn_sec_audit_0002",
      event: "push",
      delivery_id: "d-tamper",
      signature: goodSig,
      body: payload + "TAMPER"
    }
  });
  assert.equal(tampered.status, 200);
  assert.equal(tampered.body.accepted, false);
  assert.equal(tampered.body.reason, "signature_mismatch", "篡改后应视为 signature_mismatch");

  // 3.4 url_token_mismatch：token 错误
  const badToken = await api("/api/simulate-delivery", {
    method: "POST",
    body: {
      webhook_id: "wh_sec_audit",
      token: "tkn_wrong",
      event: "push",
      delivery_id: "d-badtoken",
      signature: goodSig,
      body: payload
    }
  });
  assert.equal(badToken.status, 200);
  assert.equal(badToken.body.accepted, false);
  assert.equal(badToken.body.reason, "url_token_mismatch");

  // 3.5 secret_missing：wh_dev_sandbox require_signature=true 但 secret=""
  //     即便携带看似合法的签名，也必须 fail-closed 到 secret_missing（AC-5）
  const anySig = sign("whatever", payload);
  const noSecret = await api("/api/simulate-delivery", {
    method: "POST",
    body: {
      webhook_id: "wh_dev_sandbox",
      token: "tkn_dev_sandbox_0003",
      event: "ping",
      delivery_id: "d-nosec",
      signature: anySig,
      body: payload
    }
  });
  assert.equal(noSecret.status, 200);
  assert.equal(noSecret.body.accepted, false);
  assert.equal(noSecret.body.reason, "secret_missing", "开启签名但未配置 secret 应 fail-closed，reason=secret_missing");

  // 3.6 未开启签名的 webhook（若未被前一测试改动）应保持 URL token 鉴权行为
  //     wh_prod_infra 在测试1中被开启并配置了 secret，这里不能假设它仍未启用。
  //     用列表读回并断言其失败模式：由于测试1中开启了，若送 wh_prod_infra + 正确 token 但无 signature，
  //     应得到 signature_missing 而不是 accepted，即"开启后未携带签名一律被拒收"（AC-2）。
  const stateNow = (await api("/api/webhooks")).body.webhooks.find((x) => x.id === "wh_prod_infra");
  if (stateNow.require_signature) {
    const r = await api("/api/simulate-delivery", {
      method: "POST",
      body: {
        webhook_id: "wh_prod_infra",
        token: "tkn_prod_infra_0001",
        event: "push",
        delivery_id: "d-post-ac2",
        body: payload
      }
    });
    assert.equal(r.body.accepted, false);
    assert.equal(r.body.reason, "signature_missing", "开启后未携带签名必须拒收");
  }

  // 所有失败记录都应写入 deliveries，reason 保留
  const dels = (await api("/api/deliveries")).body.deliveries;
  const byId = Object.fromEntries(dels.map((d) => [d.delivery_id, d]));
  for (const id of ["d-miss", "d-mismatch", "d-tamper", "d-badtoken", "d-nosec"]) {
    assert.ok(byId[id], `deliveries 应包含 ${id}`);
    assert.equal(byId[id].accepted, false, `${id} 应为拒收`);
    assert.ok(byId[id].reason, `${id} 应有 reason`);
  }
});

// ============================================================
// 4) 附加：AC-9 关闭后回退现有 URL token 鉴权行为
// ============================================================
test("AC-9：关闭强制签名后回到 URL token 鉴权，无需重启", async () => {
  // 关闭 wh_sec_audit 的强制签名（admin）
  const off = await api("/api/webhooks/wh_sec_audit/signature", {
    method: "PUT", actor: "operator_bob", body: { require_signature: false }
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.webhook.require_signature, false);

  // 不带 signature，也应受理（回到仅 URL token 鉴权）
  const r = await api("/api/simulate-delivery", {
    method: "POST",
    body: {
      webhook_id: "wh_sec_audit",
      token: "tkn_sec_audit_0002",
      event: "push",
      delivery_id: "d-after-off",
      body: JSON.stringify({ x: 1 })
    }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, true, "关闭签名后无签名请求应被受理");

  // 但错误 token 仍应拒收
  const badToken = await api("/api/simulate-delivery", {
    method: "POST",
    body: {
      webhook_id: "wh_sec_audit",
      token: "wrong_token",
      event: "push",
      delivery_id: "d-off-badtoken",
      body: "{}"
    }
  });
  assert.equal(badToken.body.accepted, false);
  assert.equal(badToken.body.reason, "url_token_mismatch");
});

// ============================================================
// 5) 附加：GET / 注入 data-api="1" 标记（README 明示的服务端渲染行为）
// ============================================================
test("GET / 由服务端注入 data-api=\"1\"，用于前后端联调标记", async () => {
  const res = await fetch(baseUrl + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html[^>]*\sdata-api="1"/, "根页面应包含 data-api=\"1\"");
});
