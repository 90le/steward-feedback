// Independent acceptance tests for PRD v6 snooze prototype r1
// Uses Node built-in test/assert/child_process/fetch only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
if (!CANDIDATE_DIR) throw new Error('CANDIDATE_DIR env required');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

let child, base;

before(async () => {
  const port = await getFreePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(CANDIDATE_DIR, 'server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: '/tmp'
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  // Wait for server ready
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) { await r.json(); return; }
    } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('server did not become ready');
});

after(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await sleep(200);
    if (!child.killed) child.kill('SIGKILL');
  }
});

async function api(method, path, actingUser, body) {
  const headers = {};
  if (actingUser !== undefined) headers['X-Acting-User'] = actingUser;
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(`${base}${path}`, opts);
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// ---------------- Tests ----------------

test('R16/AC20 主流程：可信入口用允许 header 能加载本人提醒；两个入口映射同一本人', async () => {
  // Only send allowed headers (X-Acting-User). Server must accept and return list.
  const rA = await api('GET', '/api/reminders', 'u_alice');
  assert.equal(rA.status, 200);
  assert.equal(rA.json?.ok, true);
  assert.equal(rA.json?.ownerId, 'u_alice');
  assert.ok(Array.isArray(rA.json?.reminders));
  assert.ok(rA.json.reminders.length > 0, 'Alice 应有至少一条提醒');
  for (const r of rA.json.reminders) {
    assert.equal(r.ownerId, 'u_alice');
  }
  // Entry B (u_alice2) maps to same person; should see identical set
  const rB = await api('GET', '/api/reminders', 'u_alice2');
  assert.equal(rB.status, 200);
  assert.equal(rB.json?.ownerId, 'u_alice');
  const idsA = rA.json.reminders.map(r => r.id).sort();
  const idsB = rB.json.reminders.map(r => r.id).sort();
  assert.deepEqual(idsB, idsA, '同一人两个入口应看到相同的提醒集合');
});

test('身份边界：缺失/非法身份头拒绝；他人的提醒不可操作（R6/AC9）', async () => {
  // Missing acting user
  const noHeader = await api('GET', '/api/reminders', undefined);
  assert.equal(noHeader.status, 401, '缺少身份头应 401');
  assert.equal(noHeader.json?.ok, false);
  // Illegal acting user
  const illegal = await api('GET', '/api/reminders', 'unknown_user');
  assert.equal(illegal.status, 401);
  // Injection-y characters
  const bad = await api('GET', '/api/reminders', 'u_alice; drop');
  assert.equal(bad.status, 401);

  // Alice tries to snooze Bob's reminder -> 403, Bob's state unchanged
  const before = await api('GET', '/api/reminders', 'u_bob');
  assert.equal(before.status, 200);
  const bobRem = before.json.reminders[0];
  assert.ok(bobRem, 'Bob 应有提醒');
  const future = Date.now() + 60_000;
  const cross = await api('POST', `/api/reminders/${bobRem.id}/snooze`, 'u_alice', { snoozeUntil: future });
  assert.equal(cross.status, 403, '他人提醒不可操作应 403');
  assert.equal(cross.json?.ok, false);
  const afterBob = await api('GET', '/api/reminders', 'u_bob');
  const same = afterBob.json.reminders.find(r => r.id === bobRem.id);
  assert.equal(same.snoozeUntil, bobRem.snoozeUntil, 'Bob 该提醒的 snoozeUntil 未被越权修改');
  assert.equal(same.done, bobRem.done);
  assert.equal(same.state, bobRem.state);
});

test('R1/R2/AC1 设置延后后 state=snoozed；AC7/R8 过去时间校验失败且保持原状态；R15/AC19 失败不呈现成功', async () => {
  const list = await api('GET', '/api/reminders', 'u_alice');
  const target = list.json.reminders.find(r => !r.done);
  assert.ok(target);
  const originalState = target.state;
  const originalSnooze = target.snoozeUntil;

  // AC7 past time: should fail
  const now = Date.now();
  const past = now - 5000;
  const fail = await api('POST', `/api/reminders/${target.id}/snooze`, 'u_alice', { snoozeUntil: past });
  assert.equal(fail.status, 400, '过去时间应返回 400');
  assert.equal(fail.json?.ok, false, '失败响应 ok=false（R15/AC19：不呈现成功）');
  assert.ok(typeof fail.json?.now === 'number', '应携带服务器权威 now 以支持 AC13');

  // Verify state unchanged
  const afterFail = await api('GET', '/api/reminders', 'u_alice');
  const stillTarget = afterFail.json.reminders.find(r => r.id === target.id);
  assert.equal(stillTarget.snoozeUntil, originalSnooze, '失败提交后 snoozeUntil 未变化');
  assert.equal(stillTarget.state, originalState, '失败提交后 state 未变化');

  // Valid future snooze
  const until = Date.now() + 60_000;
  const ok = await api('POST', `/api/reminders/${target.id}/snooze`, 'u_alice', { snoozeUntil: until });
  assert.equal(ok.status, 200);
  assert.equal(ok.json?.ok, true);
  assert.equal(ok.json.reminder.state, 'snoozed');
  assert.equal(ok.json.reminder.snoozeUntil, until);

  // AC5 cancel restores active
  const cancelled = await api('POST', `/api/reminders/${target.id}/cancel`, 'u_alice');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.reminder.state, 'active');
  assert.equal(cancelled.json.reminder.snoozeUntil, null);
});

test('R9/AC10/AC15 明确处理立即取消延后且跨入口一致', async () => {
  const list = await api('GET', '/api/reminders', 'u_alice');
  const target = list.json.reminders.find(r => !r.done && r.id === 'r_a_2') || list.json.reminders.find(r => !r.done);
  assert.ok(target);
  // Snooze first
  const until = Date.now() + 120_000;
  const snoozed = await api('POST', `/api/reminders/${target.id}/snooze`, 'u_alice', { snoozeUntil: until });
  assert.equal(snoozed.json.reminder.state, 'snoozed');
  // Mark done from entry A (u_alice)
  const done = await api('POST', `/api/reminders/${target.id}/done`, 'u_alice');
  assert.equal(done.status, 200);
  assert.equal(done.json.reminder.done, true);
  assert.equal(done.json.reminder.state, 'done', '标记 done 后 state=done');
  assert.equal(done.json.reminder.snoozeUntil, null, 'R9：done 同时取消 snoozeUntil');
  // Entry B (u_alice2) sees consistent state
  const viaB = await api('GET', '/api/reminders', 'u_alice2');
  const seen = viaB.json.reminders.find(r => r.id === target.id);
  assert.equal(seen.done, true, 'AC15：入口 B 看到已处理');
  assert.equal(seen.state, 'done');
  assert.equal(seen.snoozeUntil, null);

  // Done reminder cannot be snoozed again (server business rule)
  const reSnooze = await api('POST', `/api/reminders/${target.id}/snooze`, 'u_alice', { snoozeUntil: Date.now() + 60_000 });
  assert.equal(reSnooze.status, 409, '已 done 的提醒不能再 snooze');
  assert.equal(reSnooze.json.ok, false);
});

test('R17/AC21 后端权威时间校验：+15m/+1h/+1d 之类的合法未来时间均可成功保存', async () => {
  const list = await api('GET', '/api/reminders', 'u_alice');
  // Find any non-done reminder that we can snooze
  const target = list.json.reminders.find(r => !r.done);
  assert.ok(target);
  const health = await api('GET', '/api/health');
  const serverNow = health.json.now;
  const offsets = [15 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
  for (const off of offsets) {
    const until = serverNow + off;
    const r = await api('POST', `/api/reminders/${target.id}/snooze`, 'u_alice', { snoozeUntil: until });
    assert.equal(r.status, 200, `+${off}ms 快捷项对应的未来时间应能保存成功`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.reminder.state, 'snoozed');
    assert.equal(r.json.reminder.snoozeUntil, until);
  }
  // Cleanup: cancel
  await api('POST', `/api/reminders/${target.id}/cancel`, 'u_alice');
});

test('原消息定位：/api/reminders/:id/message 返回原消息内容与会话切片（R3/AC3/AC14）', async () => {
  const list = await api('GET', '/api/reminders', 'u_alice');
  const target = list.json.reminders.find(r => !r.done);
  assert.ok(target);
  const r = await api('GET', `/api/reminders/${target.id}/message`, 'u_alice');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.message, '应返回原消息');
  assert.equal(r.json.message.id, target.messageId, '返回消息 id 应与提醒关联的 messageId 一致');
  assert.ok(typeof r.json.message.body === 'string' && r.json.message.body.length > 0, '原消息应有内容（非仅"已定位"文字）');
  assert.ok(Array.isArray(r.json.chat) && r.json.chat.length > 1, '应返回会话切片（含多条消息）以支持定位');
  const foundInChat = r.json.chat.find(m => m.id === target.messageId);
  assert.ok(foundInChat, '目标消息应出现在返回的会话切片中');

  // Bob cannot view Alice's message
  const denied = await api('GET', `/api/reminders/${target.id}/message`, 'u_bob');
  assert.equal(denied.status, 403);
});

test('/ 入口注入 data-api="1"（R16 联调模式声明）', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<html\b[^>]*\bdata-api\s*=\s*"1"/i, 'GET / 应注入 data-api="1"');
});
