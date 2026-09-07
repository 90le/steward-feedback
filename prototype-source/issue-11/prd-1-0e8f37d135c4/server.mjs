// server.mjs
// incoming-webhooks GitHub 强制签名校验能力 · 原型后端
// 仅使用 Node 内置模块；处理内存中的模拟数据；不写宿主文件、不联外部服务。
// 该原型不是 octo-server 真实实现，仅演示 PRD v1 描述的用户可感知行为。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

// ---------- 内存数据 ----------
const users = {
  admin_alice: { name: "管理员 Alice", role: "admin" },
  operator_bob: { name: "运维 Bob", role: "admin" },
  viewer_carol: { name: "只读 Carol", role: "viewer" },
  anonymous: { name: "未登录", role: "anon" }
};

const webhooks = [
  { id: "wh_prod_infra", token: "tkn_prod_infra_0001", label: "生产 · infra 通知", require_signature: false, secret: "" },
  { id: "wh_sec_audit", token: "tkn_sec_audit_0002", label: "安全审计（需强制签名）", require_signature: true, secret: "s3cret-audit-A" },
  { id: "wh_dev_sandbox", token: "tkn_dev_sandbox_0003", label: "研发沙箱", require_signature: true, secret: "" }
];

const deliveries = []; // {at, webhook_id, event, delivery_id, accepted, reason}

function publicWebhook(w) {
  return {
    id: w.id, token: w.token, label: w.label,
    require_signature: w.require_signature,
    has_secret: !!w.secret
    // 注意：secret 明文不进入任何读接口响应（UR-6/AC-8）
  };
}

// ---------- 工具 ----------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return resolve({});
      try { resolve(JSON.parse(buf.toString("utf8"))); }
      catch (e) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function getActor(req) {
  const uid = String(req.headers["x-acting-user"] || req.headers["x-user-id"] || "anonymous").slice(0, 64);
  const user = users[uid] || users.anonymous;
  return { uid, role: user.role, name: user.name };
}

function requireAdmin(actor) {
  if (actor.role !== "admin") return { ok: false, error: "forbidden", detail: "requires admin role" };
  return { ok: true };
}

function findWebhook(id) { return webhooks.find((w) => w.id === id); }

function evaluateSignature(w, headers, body /* string */) {
  // 与 PRD 描述一致的判定顺序
  if (!w.require_signature) return { accepted: true, reason: "" };
  if (!w.secret) return { accepted: false, reason: "secret_missing" };
  const provided = headers["x-hub-signature-256"] || headers["X-Hub-Signature-256"];
  if (!provided || typeof provided !== "string") return { accepted: false, reason: "signature_missing" };
  const expect = "sha256=" + createHmac("sha256", w.secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(expect);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return { accepted: false, reason: "signature_mismatch" };
  try {
    if (timingSafeEqual(a, b)) return { accepted: true, reason: "" };
    return { accepted: false, reason: "signature_mismatch" };
  } catch { return { accepted: false, reason: "signature_mismatch" }; }
}

function nowIso() { return new Date().toISOString().replace("T", " ").replace(/\..*/, ""); }

function recordDelivery(entry) {
  deliveries.push(entry);
  if (deliveries.length > 200) deliveries.splice(0, deliveries.length - 200);
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const path = url.pathname;
  const actor = getActor(req);

  if (path === "/api/health" && req.method === "GET") {
    return json(res, 200, { status: "ok", now: nowIso(), actor });
  }

  if (path === "/api/whoami" && req.method === "GET") {
    return json(res, 200, { actor });
  }

  if (path === "/api/webhooks" && req.method === "GET") {
    return json(res, 200, { webhooks: webhooks.map(publicWebhook) });
  }

  if (path === "/api/deliveries" && req.method === "GET") {
    return json(res, 200, { deliveries: deliveries.slice(-50) });
  }

  // /api/webhooks/:id/signature  PUT
  let m = path.match(/^\/api\/webhooks\/([A-Za-z0-9_-]+)\/signature$/);
  if (m && req.method === "PUT") {
    const chk = requireAdmin(actor); if (!chk.ok) return json(res, 403, chk);
    const w = findWebhook(m[1]); if (!w) return json(res, 404, { error: "not_found" });
    let body; try { body = await readJsonBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (typeof body.require_signature !== "boolean") return json(res, 400, { error: "invalid_body", detail: "require_signature boolean required" });
    w.require_signature = body.require_signature;
    return json(res, 200, { ok: true, webhook: publicWebhook(w) });
  }

  // /api/webhooks/:id/secret  PUT
  m = path.match(/^\/api\/webhooks\/([A-Za-z0-9_-]+)\/secret$/);
  if (m && req.method === "PUT") {
    const chk = requireAdmin(actor); if (!chk.ok) return json(res, 403, chk);
    const w = findWebhook(m[1]); if (!w) return json(res, 404, { error: "not_found" });
    let body; try { body = await readJsonBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (typeof body.secret !== "string") return json(res, 400, { error: "invalid_body", detail: "secret string required" });
    if (body.secret.length > 512) return json(res, 400, { error: "secret_too_long" });
    w.secret = body.secret;
    // 响应中不返回原文
    return json(res, 200, { ok: true, webhook: publicWebhook(w) });
  }

  // /api/simulate-delivery  POST
  // 通过统一 API 触发一次投递校验，避免依赖预览沙箱允许任意 :webhook_id 动态路径。
  if (path === "/api/simulate-delivery" && req.method === "POST") {
    let body; try { body = await readJsonBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const { webhook_id, token, event, delivery_id, signature, body: payloadBody } = body || {};
    if (typeof webhook_id !== "string" || typeof token !== "string" || typeof event !== "string" || typeof payloadBody !== "string") {
      return json(res, 400, { error: "invalid_body" });
    }
    const w = findWebhook(webhook_id);
    if (!w) return json(res, 404, { error: "webhook_not_found" });

    let result;
    if (token !== w.token) {
      result = { accepted: false, reason: "url_token_mismatch" };
    } else {
      const sigResult = evaluateSignature(w, { "x-hub-signature-256": signature || "" }, payloadBody);
      result = sigResult;
    }
    recordDelivery({
      at: nowIso(), webhook_id: w.id, event, delivery_id: delivery_id || null,
      accepted: result.accepted, reason: result.reason
    });
    return json(res, 200, result);
  }

  return json(res, 404, { error: "not_found", path });
}

// ---------- 前端注入 data-api 标记 ----------
let cachedHtml = null;
async function serveIndex(res) {
  if (!cachedHtml) {
    const raw = await readFile(join(__dirname, "index.html"), "utf8");
    // 给 <html> 打 data-api="1" 标记
    cachedHtml = raw.replace(/<html(\s[^>]*)?>/i, (m, attrs) => {
      const a = attrs || "";
      if (/data-api\s*=/.test(a)) return m;
      return `<html${a} data-api="1">`;
    });
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(cachedHtml);
}

// ---------- 主服务 ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/" && req.method === "GET") return serveIndex(res);
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    return json(res, 404, { error: "not_found", path: url.pathname });
  } catch (e) {
    return json(res, 500, { error: "server_error", detail: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[prototype] listening on http://127.0.0.1:${PORT}  (PID ${process.pid})`);
});
