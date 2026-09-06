// 独立验收：群置顶到期自动取消（PRD v2）
// 通过启动 /candidate/.../server.mjs 子进程发真实 HTTP 请求核对用户结果。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
assert.ok(CANDIDATE_DIR, 'CANDIDATE_DIR must be set');

function pickFreePort() {
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
let base;

async function waitReady(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + '/api/health');
      if (r.ok) return await r.json();
    } catch (e) { lastErr = e; }
    await sleep(100);
  }
  throw new Error('server not ready: ' + (lastErr && lastErr.message));
}

before(async () => {
  const port = await pickFreePort();
  base = `http://127.0.0.1:${port}`;
  const entry = join(CANDIDATE_DIR, 'server.mjs');
  child = spawn(process.execPath, [entry], {
    cwd: '/tmp',
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitReady(base);
});

after(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise(res => child.on('exit', res));
  }
});

function api(path, { method = 'GET', user, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['X-User-Id'] = user;
  return fetch(base + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
}

// 主流程：发送带到期时间的置顶消息 → 到期后自动解除置顶，且原消息保留、内容一致
test('主流程：置顶带到期时间，到期后静默取消置顶且消息保留', async () => {
  const expireAt = Date.now() + 1500;
  const r1 = await api('/api/messages', { method: 'POST', user: 'admin', body: { text: '限时报名通知：今晚 20:00 截止', pin: true, expireAt } });
  assert.equal(r1.status, 200, '创建消息应返回 200');
  const created = (await r1.json()).message;
  assert.equal(created.pinned, true, '刚创建时应为置顶');
  assert.equal(created.expireAt, expireAt, 'expireAt 应保留');
  assert.equal(created.text, '限时报名通知：今晚 20:00 截止');
  const msgId = created.id;

  // 到期前应仍处于置顶
  const midR = await api('/api/messages', { user: 'admin' });
  const midMsg = (await midR.json()).messages.find(m => m.id === msgId);
  assert.ok(midMsg, '中途消息应存在');
  assert.equal(midMsg.pinned, true, '到期前仍应置顶');

  // 等待到期 + 扫描周期
  await sleep(2500);

  const finalR = await api('/api/messages', { user: 'admin' });
  assert.equal(finalR.status, 200);
  const list = (await finalR.json()).messages;
  const after = list.find(m => m.id === msgId);
  assert.ok(after, '到期后原消息应仍在列表（未被删除）');
  assert.equal(after.pinned, false, '到期后应自动取消置顶');
  assert.equal(after.expireAt, null, '到期后 expireAt 应清空');
  assert.equal(after.text, '限时报名通知：今晚 20:00 截止', '原消息内容不应被修改');

  // 健康检查也不应报告该消息仍置顶（仅健康接口自身用途）
  const h = await (await api('/api/health')).json();
  assert.equal(typeof h.pinned, 'number');
});

// 服务端身份/业务边界：无权限身份和未知身份都不能设到期，操作对已存在置顶不生效
test('服务端身份/权限边界：无权限成员与未知身份都无法修改到期', async () => {
  // 未知身份：401
  const anon = await api('/api/messages/2/expire', { method: 'PUT', body: { expireAt: Date.now() + 60000 } });
  assert.equal(anon.status, 401, '缺少 X-User-Id 应返回 401');
  const anonBody = await anon.json();
  assert.equal(anonBody.error.code, 'unauthenticated');

  // 演示消息 #2 是长期置顶（expireAt=null）；记录初始状态
  const before = (await (await api('/api/messages', { user: 'admin' })).json()).messages.find(m => m.id === 2);
  assert.ok(before, '演示消息 #2 应存在');
  assert.equal(before.pinned, true);
  assert.equal(before.expireAt, null);

  // member 无置顶权限：应 403
  const forbid = await api('/api/messages/2/expire', { method: 'PUT', user: 'member', body: { expireAt: Date.now() + 60000 } });
  assert.equal(forbid.status, 403, '无置顶权限应返回 403');
  const fBody = await forbid.json();
  assert.equal(fBody.error.code, 'forbidden');

  // member 也不能发置顶消息
  const forbidPost = await api('/api/messages', { method: 'POST', user: 'member', body: { text: '试探', pin: true } });
  assert.equal(forbidPost.status, 403);
  assert.equal((await forbidPost.json()).error.code, 'forbidden');

  // 状态未变
  const afterState = (await (await api('/api/messages', { user: 'admin' })).json()).messages.find(m => m.id === 2);
  assert.equal(afterState.pinned, true, '越权尝试后原置顶不应受影响');
  assert.equal(afterState.expireAt, null, '越权尝试后原到期时间不应受影响');
});

// 失败保持状态：设置过去时间应失败，且原有置顶与到期时间保持不变
test('失败保持状态：过去时间被拒绝且不改动原有到期', async () => {
  // 先由 admin 创建一条带未来到期的置顶消息
  const future1 = Date.now() + 60 * 60 * 1000; // 1 小时后
  const createR = await api('/api/messages', { method: 'POST', user: 'admin', body: { text: '本周五分享会', pin: true, expireAt: future1 } });
  assert.equal(createR.status, 200);
  const msg = (await createR.json()).message;
  assert.equal(msg.pinned, true);
  assert.equal(msg.expireAt, future1);

  // 尝试把到期改成过去时间
  const past = Date.now() - 5000;
  const badR = await api(`/api/messages/${msg.id}/expire`, { method: 'PUT', user: 'admin', body: { expireAt: past } });
  assert.equal(badR.status, 400, '不晚于当前时间应返回 400');
  const badBody = await badR.json();
  assert.equal(badBody.error.code, 'invalid_expire');

  // 原状态应保持不变
  const check1 = (await (await api('/api/messages', { user: 'admin' })).json()).messages.find(m => m.id === msg.id);
  assert.equal(check1.pinned, true, '失败后仍应置顶');
  assert.equal(check1.expireAt, future1, '失败后原到期时间不应被覆盖');

  // 尝试把到期改成非法值
  const badR2 = await api(`/api/messages/${msg.id}/expire`, { method: 'PUT', user: 'admin', body: { expireAt: 'not-a-number' } });
  assert.equal(badR2.status, 400);
  assert.equal((await badR2.json()).error.code, 'invalid_expire');
  const check2 = (await (await api('/api/messages', { user: 'admin' })).json()).messages.find(m => m.id === msg.id);
  assert.equal(check2.expireAt, future1, '非法值失败后到期时间不应变');

  // 合法修改：改成 2 小时后
  const future2 = Date.now() + 2 * 60 * 60 * 1000;
  const okR = await api(`/api/messages/${msg.id}/expire`, { method: 'PUT', user: 'admin', body: { expireAt: future2 } });
  assert.equal(okR.status, 200);
  const okMsg = (await okR.json()).message;
  assert.equal(okMsg.expireAt, future2, '合法调整应写入新到期');
  assert.equal(okMsg.pinned, true);

  // 取消到期（expireAt=null）：应保留置顶
  const nullR = await api(`/api/messages/${msg.id}/expire`, { method: 'PUT', user: 'admin', body: { expireAt: null } });
  assert.equal(nullR.status, 200);
  const nulled = (await nullR.json()).message;
  assert.equal(nulled.expireAt, null);
  assert.equal(nulled.pinned, true, '取消到期后应恢复为无到期的长期置顶');
});

// 对未置顶消息设置到期应被拒绝（业务边界），且不改动其状态
test('业务边界：不能给未置顶消息设置到期', async () => {
  // 演示消息 #1 未置顶
  const before = (await (await api('/api/messages', { user: 'admin' })).json()).messages.find(m => m.id === 1);
  assert.ok(before);
  assert.equal(before.pinned, false);

  const r = await api('/api/messages/1/expire', { method: 'PUT', user: 'admin', body: { expireAt: Date.now() + 30000 } });
  assert.equal(r.status, 409, '未置顶消息不应能设到期');
  const body = await r.json();
  assert.equal(body.error.code, 'not_pinned');

  const after = (await (await api('/api/messages', { user: 'admin' })).json()).messages.find(m => m.id === 1);
  assert.equal(after.pinned, false);
  assert.equal(after.expireAt, null);
});
