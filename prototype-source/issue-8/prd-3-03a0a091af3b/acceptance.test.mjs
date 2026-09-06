// 独立验收测试：群投票发起人修改未截止投票截止时间（PRD v3）
// 启动 CANDIDATE_DIR/server.mjs 作为子进程，通过 127.0.0.1 真实 HTTP 校验。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
if (!CANDIDATE_DIR) throw new Error('CANDIDATE_DIR not set');
const SERVER_ENTRY = path.join(CANDIDATE_DIR, 'server.mjs');

function getFreePort(){
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

let child, BASE, PORT;

async function waitHealthy(base, ms = 5000){
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < ms){
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok){
        const j = await r.json();
        if (j.ok) return j;
      }
    } catch (e){ lastErr = e; }
    await sleep(80);
  }
  throw new Error('server not healthy: ' + (lastErr && lastErr.message));
}

before(async () => {
  PORT = await getFreePort();
  BASE = `http://127.0.0.1:${PORT}`;
  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), TMPDIR: '/tmp' },
    cwd: '/tmp',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitHealthy(BASE, 6000);
  // 重置一次，确保测试从种子状态开始
  const r = await fetch(BASE + '/api/reset', { method:'POST' });
  assert.equal(r.status, 200);
});

after(async () => {
  if (child && !child.killed){
    child.kill('SIGTERM');
    await new Promise(res => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} res(); }, 1500);
      child.once('exit', () => { clearTimeout(t); res(); });
    });
  }
});

async function api(pathname, { method='GET', user, body } = {}){
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-user-id'] = user;
  const r = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await r.text();
  if (text) { try { json = JSON.parse(text); } catch {} }
  return { status: r.status, json };
}

async function getPoll(id, user){
  const r = await api('/api/polls', { user });
  assert.equal(r.status, 200);
  const p = r.json.polls.find(x => x.id === id);
  assert.ok(p, 'poll ' + id + ' not found');
  return p;
}

// --------- 测试 1：主流程 —— 发起人修改未截止投票，界面显示新时间，已投票成员收到一次通知（R1/R3/R4/AC1/AC4/AC5）
test('主流程：发起人修改未截止投票截止时间并只通知一次已投票成员', async () => {
  await fetch(BASE + '/api/reset', { method:'POST' });

  // 起始状态
  const before = await getPoll('p1', 'u_alice');
  assert.equal(before.ownerId, 'u_alice');
  assert.equal(before.isClosed, false);
  assert.equal(before.isOwner, true);
  const oldDeadline = before.deadline;

  // Bob 是已投票成员
  const bobView = await getPoll('p1', 'u_bob');
  assert.equal(bobView.myVote, 'o1', 'Bob 应已投火锅');

  // 发起人修改截止时间 -> 未来 3 小时
  const newDeadline = new Date(Date.now() + 3*60*60*1000).toISOString();
  const patch = await api('/api/polls/p1/deadline', { method:'PATCH', user:'u_alice', body:{ deadline: newDeadline }});
  assert.equal(patch.status, 200, 'PATCH 应成功');
  assert.equal(patch.json.ok, true);
  assert.equal(patch.json.poll.deadline, newDeadline, '响应中的 deadline 应是新值');

  // 列表应显示新时间（AC4）
  const after = await getPoll('p1', 'u_alice');
  assert.equal(after.deadline, newDeadline);
  assert.notEqual(after.deadline, oldDeadline);

  // Bob（已投票）应收到 1 条通知，指向 p1，携带 old/new（AC5/R4）
  const notesBob1 = await api('/api/notices', { user:'u_bob' });
  assert.equal(notesBob1.status, 200);
  const bobPollNotices = notesBob1.json.notices.filter(n => n.pollId === 'p1');
  assert.equal(bobPollNotices.length, 1, 'Bob 应收到 1 条 p1 通知');
  assert.equal(bobPollNotices[0].oldDeadline, oldDeadline);
  assert.equal(bobPollNotices[0].newDeadline, newDeadline);

  // Carol 未投 p1，不应收到 p1 的通知（N6：不广播）
  const notesCarol = await api('/api/notices', { user:'u_carol' });
  assert.equal(notesCarol.status, 200);
  const carolPollNotices = notesCarol.json.notices.filter(n => n.pollId === 'p1');
  assert.equal(carolPollNotices.length, 0, 'Carol 未投 p1 不应收到 p1 通知');

  // 再次“查看”不会产生重复通知（AC5：不重复提示同一位已投成员）
  const notesBob2 = await api('/api/notices', { user:'u_bob' });
  const bobPollNotices2 = notesBob2.json.notices.filter(n => n.pollId === 'p1');
  assert.equal(bobPollNotices2.length, 1, '再次查询不应新增通知');
});

// --------- 测试 2：服务端身份/业务边界 —— 非发起人被 403，已截止投票被 409，且失败保持原状态（R2/R5/R6/AC2/AC3/AC6/AC7）
test('服务端独立校验：非发起人 403、已截止 409、失败不改状态', async () => {
  await fetch(BASE + '/api/reset', { method:'POST' });

  // 起点：p1 归 Alice，未截止；p3 归 Alice，已截止
  const p1Before = await getPoll('p1', 'u_alice');
  const p3Before = await getPoll('p3', 'u_alice');
  assert.equal(p1Before.isClosed, false);
  assert.equal(p3Before.isClosed, true);

  const future = new Date(Date.now() + 60*60*1000).toISOString();

  // 非发起人 Bob 尝试改 p1 -> 403 not_owner
  const bobPatch = await api('/api/polls/p1/deadline', { method:'PATCH', user:'u_bob', body:{ deadline: future }});
  assert.equal(bobPatch.status, 403, '非发起人应被拒绝');
  assert.equal(bobPatch.json.error, 'not_owner');

  // 管理员也不例外（N1）
  const adminPatch = await api('/api/polls/p1/deadline', { method:'PATCH', user:'u_admin', body:{ deadline: future }});
  assert.equal(adminPatch.status, 403);
  assert.equal(adminPatch.json.error, 'not_owner');

  // 未认证（无 x-user-id）-> 401
  const anonPatch = await api('/api/polls/p1/deadline', { method:'PATCH', body:{ deadline: future }});
  assert.equal(anonPatch.status, 401);
  assert.equal(anonPatch.json.error, 'not_authenticated');

  // 发起人 Alice 改已截止的 p3 -> 409 poll_closed（AC3）
  const closedPatch = await api('/api/polls/p3/deadline', { method:'PATCH', user:'u_alice', body:{ deadline: future }});
  assert.equal(closedPatch.status, 409);
  assert.equal(closedPatch.json.error, 'poll_closed');

  // 失败后原状态不变（AC6/AC7）：deadline 未改动、投票记录未变
  const p1After = await getPoll('p1', 'u_alice');
  const p3After = await getPoll('p3', 'u_alice');
  assert.equal(p1After.deadline, p1Before.deadline, '被拒后 p1.deadline 不应变动');
  assert.equal(p3After.deadline, p3Before.deadline, '被拒后 p3.deadline 不应变动');
  // 已投票记录未变
  const bobP1 = await getPoll('p1', 'u_bob');
  assert.equal(bobP1.myVote, 'o1', 'Bob 对 p1 的投票不变');
  const bobP3 = await getPoll('p3', 'u_bob');
  assert.equal(bobP3.myVote, 'x1', 'Bob 对 p3 的投票不变');
  // 总票数不变
  const p1AfterCount = p1After.options.reduce((s,o)=>s+o.count,0);
  const p1BeforeCount = p1Before.options.reduce((s,o)=>s+o.count,0);
  assert.equal(p1AfterCount, p1BeforeCount);

  // 失败分支不应产生通知
  const bobNotices = await api('/api/notices', { user:'u_bob' });
  const carolNotices = await api('/api/notices', { user:'u_carol' });
  assert.equal(bobNotices.json.notices.filter(n=>n.pollId==='p1'||n.pollId==='p3').length, 0);
  assert.equal(carolNotices.json.notices.filter(n=>n.pollId==='p1'||n.pollId==='p3').length, 0);
});

// --------- 测试 3：输入合法性 & 失败保持原状态 —— 过去时间/坏 JSON/坏格式 -> 400，deadline 不变（R5/AC6）
test('输入校验：坏 JSON / 过去时间 / 非法格式全部被 400 且状态不变', async () => {
  await fetch(BASE + '/api/reset', { method:'POST' });
  const before = await getPoll('p1', 'u_alice');

  // 过去时间
  const past = new Date(Date.now() - 60*1000).toISOString();
  const rPast = await api('/api/polls/p1/deadline', { method:'PATCH', user:'u_alice', body:{ deadline: past }});
  assert.equal(rPast.status, 400);
  assert.equal(rPast.json.error, 'deadline_not_future');

  // 非法格式
  const rBad = await api('/api/polls/p1/deadline', { method:'PATCH', user:'u_alice', body:{ deadline: 'not-a-date' }});
  assert.equal(rBad.status, 400);
  assert.equal(rBad.json.error, 'bad_deadline');

  // 坏 JSON —— 直接 raw
  const rawResp = await fetch(BASE + '/api/polls/p1/deadline', {
    method:'PATCH',
    headers:{'content-type':'application/json','x-user-id':'u_alice'},
    body: '{not json'
  });
  assert.equal(rawResp.status, 400);
  const rawJ = await rawResp.json();
  assert.equal(rawJ.error, 'bad_json');

  // 投票不存在
  const rNotFound = await api('/api/polls/no-such-poll/deadline', { method:'PATCH', user:'u_alice', body:{ deadline: new Date(Date.now()+60000).toISOString() }});
  assert.equal(rNotFound.status, 404);
  assert.equal(rNotFound.json.error, 'poll_not_found');

  // 状态未变
  const after = await getPoll('p1', 'u_alice');
  assert.equal(after.deadline, before.deadline, '所有失败分支后 deadline 都不应变');

  // 失败分支不发通知
  const bobNotices = await api('/api/notices', { user:'u_bob' });
  assert.equal(bobNotices.json.notices.filter(n=>n.pollId==='p1').length, 0);
});

// --------- 测试 4：多次成功修改累加通知（Q4 原型不设次数上限）+ 选项与投票记录不变（R6/AC7）
test('多次成功修改：新一次成功再产生一条新通知；选项/投票记录不变', async () => {
  await fetch(BASE + '/api/reset', { method:'POST' });

  const before = await getPoll('p1', 'u_alice');
  const beforeOptions = JSON.stringify(before.options.map(o=>({id:o.id,text:o.text})));

  // 第一次修改
  const d1 = new Date(Date.now() + 2*60*60*1000).toISOString();
  const r1 = await api('/api/polls/p1/deadline', { method:'PATCH', user:'u_alice', body:{ deadline: d1 }});
  assert.equal(r1.status, 200);
  // 第二次修改
  const d2 = new Date(Date.now() + 4*60*60*1000).toISOString();
  const r2 = await api('/api/polls/p1/deadline', { method:'PATCH', user:'u_alice', body:{ deadline: d2 }});
  assert.equal(r2.status, 200);

  const after = await getPoll('p1', 'u_alice');
  assert.equal(after.deadline, d2, '最终 deadline 应为最后一次修改的值');
  const afterOptions = JSON.stringify(after.options.map(o=>({id:o.id,text:o.text})));
  assert.equal(afterOptions, beforeOptions, '选项集合不应改变（R6）');

  // Bob 现在应有 2 条 p1 通知（两次不同 changeSeq）
  const bobNotices = await api('/api/notices', { user:'u_bob' });
  const p1Notices = bobNotices.json.notices.filter(n => n.pollId === 'p1');
  assert.equal(p1Notices.length, 2, 'Bob 应收到 2 条 p1 通知');
  const seqs = new Set(p1Notices.map(n => n.changeSeq));
  assert.equal(seqs.size, 2, '两条通知的 changeSeq 应不同');

  // Bob 对 p1 的投票记录未变（AC7）
  const bobView = await getPoll('p1', 'u_bob');
  assert.equal(bobView.myVote, 'o1');
});
