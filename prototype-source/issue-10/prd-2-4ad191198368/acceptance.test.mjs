// Octo 小检 - snooze 提醒功能独立验收测试
// 通过启动子进程真实 HTTP 调用验证 PRD v2 用户结果
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
if (!CANDIDATE_DIR) throw new Error('CANDIDATE_DIR is required');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let child, base;

before(async () => {
  const port = await findFreePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(CANDIDATE_DIR, 'server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    cwd: '/tmp',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  // wait ready
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) { const j = await r.json(); if (j.ok) return; }
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start in time');
});

after(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await sleep(200);
    if (!child.killed) child.kill('SIGKILL');
  }
});

async function reset() {
  const r = await fetch(`${base}/api/reset`, { method: 'POST' });
  assert.equal(r.status, 200);
}

async function list(userId, now) {
  const q = new URLSearchParams({ userId });
  if (now != null) q.set('now', String(now));
  const r = await fetch(`${base}/api/reminders?${q}`);
  assert.equal(r.status, 200, 'list should 200');
  return await r.json();
}

// ==================
// AC1 + R1/R2 + AC7: 设置 snooze -> 隐藏；不晚于当前时间应拒绝
// ==================
test('AC1/AC7 设置稍后提醒(隐藏) & 时间校验拒绝', async () => {
  await reset();
  const NOW = 1_800_000_000_000; // 固定基准时间(2027)
  const before = await list('u1', NOW);
  const target = before.reminders.find(r => r.id === 'r1');
  assert.ok(target, 'r1 应存在');
  assert.equal(target.view, 'active', '初始为 active');

  // AC7: until <= now 应被服务端拒绝，状态不改
  const bad = await fetch(`${base}/api/reminders/r1/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1', 'x-now': String(NOW) },
    body: JSON.stringify({ until: NOW }),
  });
  assert.equal(bad.status, 400, 'until<=now 应 400');
  const badBody = await bad.json();
  assert.equal(badBody.code, 'INVALID_TIME');

  const still = await list('u1', NOW);
  assert.equal(still.reminders.find(r => r.id === 'r1').view, 'active', '拒绝后仍 active (AC7 保留状态)');

  // AC1: 合法时间
  const ok = await fetch(`${base}/api/reminders/r1/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1', 'x-now': String(NOW) },
    body: JSON.stringify({ until: NOW + 15 * 60_000 }),
  });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.reminder.view, 'snoozed', '设置后为 snoozed');
  assert.equal(okBody.reminder.snoozeUntil, NOW + 15 * 60_000);

  // R2: 期间隐藏 (视图为 snoozed)
  const afterSet = await list('u1', NOW + 60_000);
  const r1After = afterSet.reminders.find(r => r.id === 'r1');
  assert.equal(r1After.view, 'snoozed', 'AC1: 在延后中视图为 snoozed');
  assert.equal(r1After.status, 'active', '原状态仍为 active');
});

// ==================
// AC3 + R3: 到达时间后重现为未处理
// ==================
test('AC3 到点重现为未处理', async () => {
  await reset();
  const NOW = 1_800_000_000_000;
  const UNTIL = NOW + 15 * 60_000;
  const set = await fetch(`${base}/api/reminders/r2/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: UNTIL, now: NOW }),
  });
  assert.equal(set.status, 200);

  // 在延后期间视图 snoozed
  const during = await list('u1', NOW + 5 * 60_000);
  assert.equal(during.reminders.find(r => r.id === 'r2').view, 'snoozed');

  // 到达 until 后
  const after1 = await list('u1', UNTIL + 1);
  const r2 = after1.reminders.find(r => r.id === 'r2');
  assert.equal(r2.view, 'active', 'AC3: 到点重现为 active 未处理');
  assert.equal(r2.status, 'active');
});

// ==================
// AC4 修改时间 & AC5 取消
// ==================
test('AC4 修改时间 & AC5 取消', async () => {
  await reset();
  const NOW = 1_800_000_000_000;
  const T1 = NOW + 15 * 60_000;
  const T2 = NOW + 60 * 60_000;

  await fetch(`${base}/api/reminders/r3/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: T1, now: NOW }),
  });

  // 修改到 T2
  const mod = await fetch(`${base}/api/reminders/r3/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: T2, now: NOW }),
  });
  assert.equal(mod.status, 200);
  const modBody = await mod.json();
  assert.equal(modBody.reminder.snoozeUntil, T2, 'AC4: 时间已更新');

  // T1 时刻仍应是 snoozed (因为改到了 T2)
  const atT1 = await list('u1', T1 + 1);
  assert.equal(atT1.reminders.find(r => r.id === 'r3').view, 'snoozed', 'AC4: T1 之后仍延后');

  // 取消 (AC5)
  const del = await fetch(`${base}/api/reminders/r3/snooze`, {
    method: 'DELETE',
    headers: { 'x-user-id': 'u1', 'x-now': String(NOW) },
  });
  assert.equal(del.status, 200);

  // 立即恢复为 active
  const afterCancel = await list('u1', NOW + 60_000);
  const r3 = afterCancel.reminders.find(r => r.id === 'r3');
  assert.equal(r3.view, 'active', 'AC5: 取消后立即 active');
  assert.equal(r3.snoozeUntil, undefined, '取消后 snoozeUntil 已清除');
});

// ==================
// AC9 + R6: 不能对他人的提醒执行操作 (身份边界)
// ==================
test('AC9 服务端拒绝对他人提醒 snooze/done', async () => {
  await reset();
  const NOW = 1_800_000_000_000;

  // r1 属于 u1，用 u2 尝试 snooze
  const bad = await fetch(`${base}/api/reminders/r1/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u2' },
    body: JSON.stringify({ until: NOW + 60_000, now: NOW }),
  });
  assert.equal(bad.status, 403, 'AC9: 非本人应 403');
  const bj = await bad.json();
  assert.equal(bj.code, 'FORBIDDEN');

  // 未认证 (无 X-User-Id) 应 401
  const noAuth = await fetch(`${base}/api/reminders/r1/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ until: NOW + 60_000, now: NOW }),
  });
  assert.equal(noAuth.status, 401);

  // u2 视图中 r1 不应存在
  const u2List = await list('u2', NOW);
  assert.ok(!u2List.reminders.find(r => r.id === 'r1'), 'u2 看不到 u1 的 r1');

  // u1 视图 r1 仍是 active (未被 u2 操作影响)
  const u1List = await list('u1', NOW);
  assert.equal(u1List.reminders.find(r => r.id === 'r1').view, 'active');
});

// ==================
// AC10 + R9: 明确处理取消延后, 到点不重现
// AC11 + R10: 仅查看不算处理, 到点仍重现
// ==================
test('AC10/AC11 明确处理清延后 & 仅查看不清延后', async () => {
  await reset();
  const NOW = 1_800_000_000_000;
  const UNTIL = NOW + 30 * 60_000;

  // r1: 设置延后, 然后 done -> AC10
  await fetch(`${base}/api/reminders/r1/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: UNTIL, now: NOW }),
  });
  const doneR = await fetch(`${base}/api/reminders/r1/done`, {
    method: 'POST',
    headers: { 'x-user-id': 'u1', 'x-now': String(NOW + 60_000) },
  });
  assert.equal(doneR.status, 200);
  const doneBody = await doneR.json();
  assert.equal(doneBody.reminder.status, 'done');
  assert.equal(doneBody.reminder.snoozeUntil, undefined, 'AC10/R9: done 后清除 snoozeUntil');
  assert.equal(doneBody.reminder.view, 'done');

  // 到达原 UNTIL 之后, 视图仍是 done, 不重现
  const afterUntil = await list('u1', UNTIL + 60_000);
  const r1After = afterUntil.reminders.find(r => r.id === 'r1');
  assert.equal(r1After.view, 'done', 'AC10: 到点后仍是 done, 不重现');

  // r2: 设置延后, 仅 view -> AC11
  await fetch(`${base}/api/reminders/r2/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: UNTIL, now: NOW }),
  });
  const viewR = await fetch(`${base}/api/reminders/r2/view`, {
    method: 'POST',
    headers: { 'x-user-id': 'u1', 'x-now': String(NOW + 60_000) },
  });
  assert.equal(viewR.status, 200);
  const viewBody = await viewR.json();
  assert.equal(viewBody.reminder.status, 'active', 'AC11: view 不改 status');
  assert.equal(viewBody.reminder.snoozeUntil, UNTIL, 'AC11: view 不清 snoozeUntil');
  assert.ok(viewBody.reminder.viewedAt, 'viewedAt 已记录');

  // 到达 UNTIL 之后应重现为 active
  const afterUntil2 = await list('u1', UNTIL + 60_000);
  const r2After = afterUntil2.reminders.find(r => r.id === 'r2');
  assert.equal(r2After.view, 'active', 'AC11: 仅 view 后到点仍重现为 active');
});

// ==================
// AC12 + R11: 操作仅影响本人; 他人对同一 messageId 的提醒不受影响
// ==================
test('AC12 操作只影响本人; 他人同 messageId 提醒不变', async () => {
  await reset();
  const NOW = 1_800_000_000_000;

  // r1(u1, m100), r4(u2, m100), r6(u3, m100) 共享 messageId
  // u1 snooze + done r1
  await fetch(`${base}/api/reminders/r1/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: NOW + 30 * 60_000, now: NOW }),
  });
  await fetch(`${base}/api/reminders/r1/done`, {
    method: 'POST',
    headers: { 'x-user-id': 'u1', 'x-now': String(NOW) },
  });

  // u2 的 r4 仍应 active
  const u2 = await list('u2', NOW);
  const r4 = u2.reminders.find(r => r.id === 'r4');
  assert.ok(r4, 'r4 存在');
  assert.equal(r4.messageId, 'm100');
  assert.equal(r4.view, 'active', 'AC12: u2 的同 messageId 提醒不受影响');
  assert.equal(r4.status, 'active');
  assert.equal(r4.snoozeUntil, undefined);

  // u3 同上
  const u3 = await list('u3', NOW);
  const r6 = u3.reminders.find(r => r.id === 'r6');
  assert.equal(r6.view, 'active');
  assert.equal(r6.status, 'active');
});

// ==================
// AC8 + R7: 已 done 的提醒无法再 snooze (业务边界); 状态保留
// ==================
test('AC8 已处理提醒不能再 snooze，状态保留', async () => {
  await reset();
  const NOW = 1_800_000_000_000;
  await fetch(`${base}/api/reminders/r3/done`, {
    method: 'POST',
    headers: { 'x-user-id': 'u1', 'x-now': String(NOW) },
  });
  const r = await fetch(`${base}/api/reminders/r3/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: NOW + 60_000, now: NOW }),
  });
  assert.equal(r.status, 409, '已处理应 409');
  const j = await r.json();
  assert.equal(j.code, 'ALREADY_DONE');

  // 状态仍 done, 无 snoozeUntil
  const list1 = await list('u1', NOW);
  const r3 = list1.reminders.find(x => x.id === 'r3');
  assert.equal(r3.view, 'done');
  assert.equal(r3.snoozeUntil, undefined);

  // 不存在的 id 返回 404
  const nf = await fetch(`${base}/api/reminders/nonexistent/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify({ until: NOW + 60_000, now: NOW }),
  });
  assert.equal(nf.status, 404);
});
