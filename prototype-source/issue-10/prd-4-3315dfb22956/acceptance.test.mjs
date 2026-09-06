// 独立验收测试：Snooze 演示 v4
// 覆盖：R1/R2 主流程、R6/R9/AC9 身份边界、R7/R8/AC7/AC8 失败保持状态、
// R3/AC3 到点重现、R10/AC11 仅查看不改状态、R9/AC10 明确处理即取消延后、
// R12/AC15/AC16 多端一致性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
if (!CANDIDATE_DIR) throw new Error('CANDIDATE_DIR env required');

function freePort() {
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

let child;
let baseUrl;

async function startServer() {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(CANDIDATE_DIR, 'server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: '/tmp',
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  // 等健康就绪
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl + '/api/health');
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server not ready. logs=' + logs);
}

async function stopServer() {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise(res => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} res(); }, 2000);
    child.once('exit', () => { clearTimeout(t); res(); });
  });
}

async function api(op, body, actingUser) {
  const headers = { 'Content-Type': 'application/json' };
  if (actingUser) headers['X-Acting-User'] = actingUser;
  const res = await fetch(`${baseUrl}/api/${op}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function reset() {
  const r = await api('reset', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
}

test('setup - start server', async () => {
  await startServer();
});

test('AC1/R1/R2 - Alice 可对本人提醒设置未来时间 snooze，随后不出现在活跃视图（listing 显示 snoozed）', async () => {
  await reset();
  // 先确认 r_a1 属于 Alice 且当前 active
  const before = await api('list', {}, 'u_alice');
  assert.equal(before.status, 200);
  const r_a1_before = before.json.data.reminders.find(r => r.id === 'r_a1');
  assert.ok(r_a1_before, '应存在 r_a1');
  assert.equal(r_a1_before.status, 'active');
  assert.equal(r_a1_before.viewStatus, 'active');

  const until = Date.now() + 60_000; // 60s 后
  const set = await api('snooze', { reminderId: 'r_a1', snoozeUntil: until }, 'u_alice');
  assert.equal(set.status, 200, 'snooze 成功 200');
  assert.equal(set.json.ok, true);
  assert.equal(set.json.data.reminder.status, 'snoozed');
  assert.equal(set.json.data.reminder.snoozeUntil, until);
  assert.equal(set.json.data.reminder.viewStatus, 'snoozed');
  assert.equal(set.json.data.reminder.reemerged, false);

  const after = await api('list', {}, 'u_alice');
  const r_a1_after = after.json.data.reminders.find(r => r.id === 'r_a1');
  assert.equal(r_a1_after.status, 'snoozed');
  assert.equal(r_a1_after.viewStatus, 'snoozed'); // 未到点，不活跃
});

test('AC7/R8 - snoozeUntil 不晚于当前时间时应拒绝，且提醒保持原状态', async () => {
  await reset();
  const past = Date.now() - 1000;
  const bad = await api('snooze', { reminderId: 'r_a1', snoozeUntil: past }, 'u_alice');
  assert.equal(bad.json.ok, false, '过去时间必须失败');
  assert.equal(bad.json.error.code, 'time_invalid');
  assert.notEqual(bad.status, 200);

  // 状态保持
  const list = await api('list', {}, 'u_alice');
  const r = list.json.data.reminders.find(x => x.id === 'r_a1');
  assert.equal(r.status, 'active');
  assert.equal(r.snoozeUntil, null);
});

test('AC9/R6/R11 - 服务端身份边界：Bob 不能操作 Alice 的提醒；未识别用户 401', async () => {
  await reset();
  // Bob 尝试 snooze r_a1 → forbidden
  const forbid = await api('snooze', { reminderId: 'r_a1', snoozeUntil: Date.now() + 60000 }, 'u_bob');
  assert.equal(forbid.status, 403);
  assert.equal(forbid.json.ok, false);
  assert.equal(forbid.json.error.code, 'forbidden');

  // 未识别用户 → 401
  const nobody = await api('snooze', { reminderId: 'r_a1', snoozeUntil: Date.now() + 60000 }, 'u_ghost');
  assert.equal(nobody.status, 401);
  assert.equal(nobody.json.error.code, 'unauthenticated');

  // Alice 视角下 r_a1 保持 active
  const list = await api('list', {}, 'u_alice');
  const r = list.json.data.reminders.find(x => x.id === 'r_a1');
  assert.equal(r.status, 'active');

  // Bob 的 list 里不含 Alice 的提醒
  const bobList = await api('list', {}, 'u_bob');
  const ids = bobList.json.data.reminders.map(r => r.id).sort();
  assert.deepEqual(ids, ['r_b1', 'r_b2']);
});

test('AC3/R3 - 到点重现：snoozeUntil 已过时 list 返回 viewStatus=active 且 reemerged=true', async () => {
  await reset();
  // 用极短未来时间 → 立即到期
  const until = Date.now() + 150;
  const set = await api('snooze', { reminderId: 'r_a1', snoozeUntil: until }, 'u_alice');
  assert.equal(set.json.ok, true);
  await new Promise(r => setTimeout(r, 250));
  const list = await api('list', {}, 'u_alice');
  const r = list.json.data.reminders.find(x => x.id === 'r_a1');
  assert.equal(r.status, 'snoozed', '底层状态仍是 snoozed');
  assert.equal(r.viewStatus, 'active', '到点后视图应为 active(重现)');
  assert.equal(r.reemerged, true);
});

test('AC10/R9 - 明确处理即取消延后：markDone 后 status=done，无重现', async () => {
  await reset();
  const until = Date.now() + 200;
  await api('snooze', { reminderId: 'r_a1', snoozeUntil: until }, 'u_alice');
  const done = await api('markDone', { reminderId: 'r_a1' }, 'u_alice');
  assert.equal(done.json.ok, true);
  assert.equal(done.json.data.reminder.status, 'done');
  assert.equal(done.json.data.reminder.snoozeUntil, null);

  // 等过原 until，再 list 不应重现
  await new Promise(r => setTimeout(r, 300));
  const list = await api('list', {}, 'u_alice');
  const r = list.json.data.reminders.find(x => x.id === 'r_a1');
  assert.equal(r.status, 'done');
  assert.equal(r.viewStatus, 'done');
  assert.equal(r.reemerged, false);
});

test('AC11/R10 - 仅查看原消息不改变提醒状态；返回真实原消息内容与会话上下文', async () => {
  await reset();
  const until = Date.now() + 60_000;
  await api('snooze', { reminderId: 'r_a1', snoozeUntil: until }, 'u_alice');
  const view = await api('viewMessage', { reminderId: 'r_a1' }, 'u_alice');
  assert.equal(view.status, 200);
  assert.equal(view.json.ok, true);
  const msg = view.json.data.message;
  assert.equal(msg.id, 'm_1');
  assert.ok(msg.text && msg.text.includes('@Alice'), '应返回真实原消息文本');
  assert.ok(Array.isArray(view.json.data.conversation), '应返回会话上下文');
  assert.ok(view.json.data.conversation.some(m => m.id === 'm_1'), '会话中应包含原消息用于定位');

  // 状态保持
  const list = await api('list', {}, 'u_alice');
  const r = list.json.data.reminders.find(x => x.id === 'r_a1');
  assert.equal(r.status, 'snoozed');
  assert.equal(r.snoozeUntil, until);
});

test('AC15/AC16/R12 - 多端一致：一处 markDone 后另一次 list（模拟另一端刷新）看到 done', async () => {
  await reset();
  const until = Date.now() + 60_000;
  await api('snooze', { reminderId: 'r_a1', snoozeUntil: until }, 'u_alice');

  // 端 A（可以带 header）标记 done
  const done = await api('markDone', { reminderId: 'r_a1' }, 'u_alice');
  assert.equal(done.json.ok, true);

  // 端 B：新的 fetch 请求作为身份 Alice 拉列表，应看到 done
  const listB = await api('list', {}, 'u_alice');
  const r = listB.json.data.reminders.find(x => x.id === 'r_a1');
  assert.equal(r.status, 'done', '另一端刷新也应看到 done');
  assert.equal(r.viewStatus, 'done');
  assert.equal(r.reemerged, false);

  // 且 Bob 的视图不变
  const listBob = await api('list', {}, 'u_bob');
  const ids = listBob.json.data.reminders.map(x => x.id).sort();
  assert.deepEqual(ids, ['r_b1', 'r_b2']);
  listBob.json.data.reminders.forEach(x => {
    assert.equal(x.status, 'active', 'Bob 的提醒不受 Alice 操作影响');
  });
});

test('AC5 - 取消延后：cancelSnooze 后 status 恢复 active，snoozeUntil 清空', async () => {
  await reset();
  const until = Date.now() + 60_000;
  await api('snooze', { reminderId: 'r_a1', snoozeUntil: until }, 'u_alice');
  const cancel = await api('cancelSnooze', { reminderId: 'r_a1' }, 'u_alice');
  assert.equal(cancel.json.ok, true);
  assert.equal(cancel.json.data.reminder.status, 'active');
  assert.equal(cancel.json.data.reminder.snoozeUntil, null);

  // 对 active 提醒再取消延后应失败（invalid_state）
  const again = await api('cancelSnooze', { reminderId: 'r_a1' }, 'u_alice');
  assert.equal(again.json.ok, false);
  assert.equal(again.json.error.code, 'invalid_state');
});

test('teardown - stop server', async () => {
  await stopServer();
});
