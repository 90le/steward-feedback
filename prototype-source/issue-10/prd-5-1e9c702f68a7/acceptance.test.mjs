// 独立验收：Octo 提醒 · 稍后再提醒（snooze）原型 r1
// 由小检编写；启动 server.mjs 子进程 → 用 fetch 打 /api/*，断言业务状态与 PRD 用户结果映射。
// 不改动候选目录；仅在 /tmp 写临时数据。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
if (!CANDIDATE_DIR) {
  throw new Error('必须通过环境变量 CANDIDATE_DIR 指定候选目录');
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, maxMs = 8000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) return j;
      }
    } catch (e) { lastErr = e; }
    await sleep(120);
  }
  throw new Error('health 未在预期时间内就绪：' + (lastErr?.message || 'unknown'));
}

async function startServer() {
  const port = await pickFreePort();
  const child = spawn(process.execPath, [join(CANDIDATE_DIR, 'server.mjs')], {
    cwd: '/tmp',
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  child.stdout.on('data', () => {}); // drain
  child.on('exit', (code, signal) => {
    if (code && code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`server exit code=${code} signal=${signal}\n${stderr}`);
    }
  });
  try {
    await waitForHealth(port);
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  }
  return {
    port,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
    })
  };
}

function api(port) {
  const base = `http://127.0.0.1:${port}`;
  return async function (method, path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.acting) headers['X-Acting-User'] = opts.acting;
    if (opts.headers) Object.assign(headers, opts.headers);
    const init = { method, headers, redirect: 'manual' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const r = await fetch(base + path, init);
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, json, text };
  };
}

test('AC1/R1 & AC2/R6: alice 设置 snooze 后列表隐藏为 snoozed；bob 视图不变', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const call = api(srv.port);

  // 初始快照
  const before = await call('GET', '/api/reminders', { acting: 'u_alice' });
  assert.equal(before.status, 200);
  assert.ok(before.json.ok);
  const rA1 = before.json.reminders.find((x) => x.id === 'r_a_1');
  assert.ok(rA1, 'alice 应看到 r_a_1');
  assert.equal(rA1.state, 'active');
  assert.equal(rA1.ownerId, 'u_alice');

  const bobBefore = await call('GET', '/api/reminders', { acting: 'u_bob' });
  assert.equal(bobBefore.status, 200);
  const bobIds = bobBefore.json.reminders.map((x) => x.id).sort();
  assert.deepEqual(bobIds, ['r_b_1', 'r_b_2'], 'bob 应看到自己的两条');
  assert.ok(!bobBefore.json.reminders.some((x) => x.id.startsWith('r_a_')), 'bob 不应看到 alice 的提醒');

  // AC1：设置 60s 后
  const until = Date.now() + 60_000;
  const set = await call('POST', '/api/reminders/r_a_1/snooze', {
    acting: 'u_alice', body: { snoozeUntil: until }
  });
  assert.equal(set.status, 200, `snooze 应成功 got ${set.status} ${set.text}`);
  assert.ok(set.json.ok);
  assert.equal(set.json.reminder.state, 'snoozed');
  assert.equal(set.json.reminder.snoozeUntil, until);
  assert.equal(set.json.reminder.done, false);

  // R2/AC1：列表里 r_a_1 现为 snoozed
  const after = await call('GET', '/api/reminders', { acting: 'u_alice' });
  const rA1After = after.json.reminders.find((x) => x.id === 'r_a_1');
  assert.equal(rA1After.state, 'snoozed');

  // AC2：bob 视图未变
  const bobAfter = await call('GET', '/api/reminders', { acting: 'u_bob' });
  assert.deepEqual(bobAfter.json.reminders.map((x) => x.id).sort(), ['r_b_1', 'r_b_2']);
  for (const b of bobAfter.json.reminders) {
    assert.equal(b.state, 'active');
    assert.equal(b.snoozeUntil, null);
    assert.equal(b.done, false);
  }
});

test('AC7/AC13/AC18/R8 & AC9/R6: 过去时间失败保持状态；他人提醒 403', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const call = api(srv.port);

  // AC7：过去时间应 400 且不改状态
  const past = Date.now() - 5000;
  const bad = await call('POST', '/api/reminders/r_a_1/snooze', {
    acting: 'u_alice', body: { snoozeUntil: past }
  });
  assert.equal(bad.status, 400, `过去时间应 400，got ${bad.status}`);
  assert.equal(bad.json.ok, false);
  assert.ok(typeof bad.json.now === 'number', '错误响应应附带 server now 用于对齐（AC13）');
  assert.ok(String(bad.json.error).length > 0);

  const list = await call('GET', '/api/reminders', { acting: 'u_alice' });
  const rA1 = list.json.reminders.find((x) => x.id === 'r_a_1');
  assert.equal(rA1.state, 'active', '失败提交后应保持 active（AC8/AC19）');
  assert.equal(rA1.snoozeUntil, null);
  assert.equal(rA1.done, false);

  // 缺少 snoozeUntil 也应保持状态
  const missing = await call('POST', '/api/reminders/r_a_1/snooze', {
    acting: 'u_alice', body: {}
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.ok, false);

  // AC9：alice 尝试操作 bob 的提醒
  const cross = await call('POST', '/api/reminders/r_b_1/snooze', {
    acting: 'u_alice', body: { snoozeUntil: Date.now() + 60_000 }
  });
  assert.equal(cross.status, 403, `跨人操作应 403，got ${cross.status}`);
  assert.equal(cross.json.ok, false);
  // 确认 bob 的提醒未被改动
  const bob = await call('GET', '/api/reminders', { acting: 'u_bob' });
  const rB1 = bob.json.reminders.find((x) => x.id === 'r_b_1');
  assert.equal(rB1.state, 'active');
  assert.equal(rB1.snoozeUntil, null);

  // 缺失身份 → 401；非法身份也 → 401
  const noId = await call('GET', '/api/reminders', {});
  assert.equal(noId.status, 401);
  const badId = await call('GET', '/api/reminders', { acting: 'stranger' });
  assert.equal(badId.status, 401);
});

test('AC10/R9 & AC15/R12: done 取消延后；同一人多入口一致（u_alice ↔ u_alice2）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const call = api(srv.port);

  // 入口 A：alice 对 r_a_2 设定 60s 延后
  const until = Date.now() + 60_000;
  const s = await call('POST', '/api/reminders/r_a_2/snooze', {
    acting: 'u_alice', body: { snoozeUntil: until }
  });
  assert.equal(s.status, 200);
  assert.equal(s.json.reminder.state, 'snoozed');

  // 入口 B（同一个人）应看到相同 snoozed 状态（AC15/AC16 一致性）
  const bView = await call('GET', '/api/reminders', { acting: 'u_alice2' });
  assert.equal(bView.json.ownerId, 'u_alice', 'u_alice2 应映射到 u_alice');
  const rA2b = bView.json.reminders.find((x) => x.id === 'r_a_2');
  assert.equal(rA2b.state, 'snoozed');
  assert.equal(rA2b.snoozeUntil, until);

  // 入口 A 明确标记为已处理（R9）
  const d = await call('POST', '/api/reminders/r_a_2/done', { acting: 'u_alice' });
  assert.equal(d.status, 200);
  assert.equal(d.json.reminder.state, 'done');
  assert.equal(d.json.reminder.done, true);
  assert.equal(d.json.reminder.snoozeUntil, null, 'done 应清除 snoozeUntil（R9）');

  // 入口 B 再查看 → 已 done，不再重现（AC15）
  const bView2 = await call('GET', '/api/reminders', { acting: 'u_alice2' });
  const rA2b2 = bView2.json.reminders.find((x) => x.id === 'r_a_2');
  assert.equal(rA2b2.state, 'done', '入口 B 应看到 done（AC15/AC16）');
  assert.equal(rA2b2.done, true);
  assert.equal(rA2b2.snoozeUntil, null);

  // AC12：bob 视图不变
  const bob = await call('GET', '/api/reminders', { acting: 'u_bob' });
  for (const r of bob.json.reminders) {
    assert.equal(r.done, false);
    assert.equal(r.snoozeUntil, null);
  }

  // done 后再 snooze 应被拒（不返回“成功”，AC19 一致性）
  const again = await call('POST', '/api/reminders/r_a_2/snooze', {
    acting: 'u_alice', body: { snoozeUntil: Date.now() + 120_000 }
  });
  assert.notEqual(again.status, 200, '已 done 的提醒再 snooze 不应返回 200');
  assert.equal(again.json.ok, false);
  // 状态仍为 done
  const finalV = await call('GET', '/api/reminders', { acting: 'u_alice2' });
  const rA2f = finalV.json.reminders.find((x) => x.id === 'r_a_2');
  assert.equal(rA2f.state, 'done');
});

test('AC4/AC5: 修改延后时间与取消延后；R5/AC6/AC14: 查看原消息不改状态', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const call = api(srv.port);

  // 先设 60s
  const t1 = Date.now() + 60_000;
  const s1 = await call('POST', '/api/reminders/r_a_1/snooze', {
    acting: 'u_alice', body: { snoozeUntil: t1 }
  });
  assert.equal(s1.status, 200);
  assert.equal(s1.json.reminder.snoozeUntil, t1);

  // AC4：改到 120s
  const t2 = Date.now() + 120_000;
  const s2 = await call('POST', '/api/reminders/r_a_1/snooze', {
    acting: 'u_alice', body: { snoozeUntil: t2 }
  });
  assert.equal(s2.status, 200);
  assert.equal(s2.json.reminder.state, 'snoozed');
  assert.equal(s2.json.reminder.snoozeUntil, t2, '再次 snooze 应修改时间');

  // AC14/R5：查看原消息不修改状态
  const msg = await call('GET', '/api/reminders/r_a_1/message', { acting: 'u_alice' });
  assert.equal(msg.status, 200);
  assert.ok(msg.json.ok);
  assert.ok(msg.json.message, '应返回原消息对象');
  assert.equal(msg.json.message.id, 'm2');
  assert.ok(typeof msg.json.message.body === 'string' && msg.json.message.body.length > 0, '消息应有实际正文（AC3/AC14 真实内容）');
  assert.ok(Array.isArray(msg.json.chat) && msg.json.chat.length > 1, '应返回会话切片用于定位（AC3/AC14）');
  const hasMsgInChat = msg.json.chat.some((m) => m.id === 'm2');
  assert.ok(hasMsgInChat, '会话切片应包含目标消息');

  // 状态仍为 snoozed，snoozeUntil 未变
  const midList = await call('GET', '/api/reminders', { acting: 'u_alice' });
  const rA1mid = midList.json.reminders.find((x) => x.id === 'r_a_1');
  assert.equal(rA1mid.state, 'snoozed', 'AC14：查看原消息不改变延后');
  assert.equal(rA1mid.snoozeUntil, t2);
  assert.equal(rA1mid.done, false);

  // AC5：取消延后 → 立即 active
  const cancel = await call('POST', '/api/reminders/r_a_1/cancel', { acting: 'u_alice' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.reminder.state, 'active');
  assert.equal(cancel.json.reminder.snoozeUntil, null);

  const afterCancel = await call('GET', '/api/reminders', { acting: 'u_alice' });
  const rA1a = afterCancel.json.reminders.find((x) => x.id === 'r_a_1');
  assert.equal(rA1a.state, 'active');
  assert.equal(rA1a.snoozeUntil, null);
  assert.equal(rA1a.done, false);

  // bob 无法查看 alice 提醒的原消息
  const spy = await call('GET', '/api/reminders/r_a_1/message', { acting: 'u_bob' });
  assert.equal(spy.status, 403, '他人不能读取本人提醒的原消息（R6/AC9）');
});

test('AC3/R3: 到点重现——snoozeUntil 到期后 state 恢复 active', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const call = api(srv.port);

  // 设一个非常短的延后（1.2s）——服务器只校验 > now 即可
  const until = Date.now() + 1200;
  const s = await call('POST', '/api/reminders/r_a_1/snooze', {
    acting: 'u_alice', body: { snoozeUntil: until }
  });
  assert.equal(s.status, 200);
  assert.equal(s.json.reminder.state, 'snoozed');

  // 立即查询 → snoozed
  const mid = await call('GET', '/api/reminders', { acting: 'u_alice' });
  assert.equal(mid.json.reminders.find((x) => x.id === 'r_a_1').state, 'snoozed');

  // 等到 snoozeUntil 之后 + 缓冲
  await sleep(1500);

  const after = await call('GET', '/api/reminders', { acting: 'u_alice' });
  const rA1 = after.json.reminders.find((x) => x.id === 'r_a_1');
  assert.equal(rA1.state, 'active', 'AC3：到点重现为活跃未处理');
  assert.equal(rA1.done, false);
  assert.equal(rA1.expired, true, '过期标志应为 true 供 UI 展示到点');
});
