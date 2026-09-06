// server.mjs — 群投票截止时间修改 · 演示后端（Node 24 内置模块）
// 仅供原型演示，不接真实用户系统，不写宿主数据，不调用外部服务。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = join(__dirname, 'index.html');
const PORT = Number(process.env.PORT) || 3000;

// ---- 模拟账户（只在内存中，不做真实鉴权，仅供原型演示）----
const USERS = {
  u_alice: { id: 'u_alice', name: 'Alice', role: 'member' },
  u_bob:   { id: 'u_bob',   name: 'Bob',   role: 'member' },
  u_carol: { id: 'u_carol', name: 'Carol', role: 'member' },
  u_dave:  { id: 'u_dave',  name: 'Dave',  role: 'member' },
  u_admin: { id: 'u_admin', name: 'Admin', role: 'admin' },
};

const nowMs = () => Date.now();
const isoIn = m => new Date(Date.now() + m*60000).toISOString();
const isoAgo = m => new Date(Date.now() - m*60000).toISOString();

function seed(){
  return {
    polls: [
      {
        id: 'p1', title: '周五团建去哪家？', ownerId: 'u_alice',
        options: [ {id:'o1', text:'火锅'}, {id:'o2', text:'烧烤'}, {id:'o3', text:'轻食'} ],
        deadline: isoIn(60), createdAt: isoAgo(30),
        votes: { u_bob: 'o1' },
        changeSeq: 0,
        notifiedFor: {}, // key: `${uid}:${changeSeq}` -> true，用于同一次修改不重复通知
      },
      {
        id: 'p2', title: '下季度技术分享主题', ownerId: 'u_dave',
        options: [ {id:'a', text:'性能'}, {id:'b', text:'安全'}, {id:'c', text:'AI'} ],
        deadline: isoIn(120), createdAt: isoAgo(10),
        votes: {},
        changeSeq: 0, notifiedFor: {},
      },
      {
        id: 'p3', title: '已截止：办公室零食采购', ownerId: 'u_alice',
        options: [ {id:'x1', text:'坚果'}, {id:'x2', text:'饼干'} ],
        deadline: isoAgo(30), createdAt: isoAgo(200),
        votes: { u_bob: 'x1', u_carol: 'x2' },
        changeSeq: 0, notifiedFor: {},
      }
    ],
    notices: { u_alice: [], u_bob: [], u_carol: [], u_dave: [], u_admin: [] },
  };
}
let state = seed();

// ---- 工具 ----
function json(res, status, body){
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store',
  });
  res.end(s);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024){ reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseJson(text){
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
}
function currentUser(req){
  // 演示原型：仅从 x-user-id 取模拟身份；不做真实鉴权
  const id = req.headers['x-user-id'];
  if (typeof id === 'string' && USERS[id]) return USERS[id];
  return null;
}
function publicPoll(p, uid){
  const counts = {};
  p.options.forEach(o => counts[o.id] = 0);
  Object.values(p.votes).forEach(oid => { if (counts[oid] != null) counts[oid]++; });
  return {
    id: p.id, title: p.title, ownerId: p.ownerId,
    options: p.options.map(o => ({ id:o.id, text:o.text, count: counts[o.id] })),
    deadline: p.deadline, createdAt: p.createdAt,
    totalVotes: Object.keys(p.votes).length,
    myVote: (uid && p.votes[uid]) || null,
    isClosed: new Date(p.deadline).getTime() <= nowMs(),
    isOwner: uid ? p.ownerId === uid : false,
  };
}

// ---- 路由 ----
async function handle(req, res){
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // 首页：注入 data-api="1"
  if (req.method === 'GET' && (p === '/' || p === '/index.html')){
    try {
      let html = await readFile(INDEX_HTML_PATH, 'utf8');
      html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-api="1">');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
    } catch (e){
      res.writeHead(500, {'content-type':'text/plain'});
      res.end('index.html not found: ' + e.message);
    }
    return;
  }

  if (req.method === 'GET' && p === '/api/health'){
    return json(res, 200, { ok:true, service:'poll-deadline-prototype', ts: new Date().toISOString(), polls: state.polls.length });
  }

  if (req.method === 'GET' && p === '/api/polls'){
    const u = currentUser(req);
    const uid = u ? u.id : null;
    return json(res, 200, { polls: state.polls.map(pl => publicPoll(pl, uid)) });
  }

  if (req.method === 'GET' && p === '/api/notices'){
    const u = currentUser(req);
    if (!u) return json(res, 401, { error:'not_authenticated', message:'请先切换到有效身份' });
    return json(res, 200, { notices: state.notices[u.id] || [] });
  }

  let m;
  if (req.method === 'POST' && (m = p.match(/^\/api\/notices\/([^/]+)\/read$/))){
    const u = currentUser(req);
    if (!u) return json(res, 401, { error:'not_authenticated' });
    const list = state.notices[u.id] || [];
    const n = list.find(x => x.id === m[1]);
    if (!n) return json(res, 404, { error:'notice_not_found' });
    n.read = true;
    return json(res, 200, { ok:true });
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/polls\/([^/]+)\/vote$/))){
    const u = currentUser(req);
    if (!u) return json(res, 401, { error:'not_authenticated' });
    const poll = state.polls.find(x => x.id === m[1]);
    if (!poll) return json(res, 404, { error:'poll_not_found' });
    if (new Date(poll.deadline).getTime() <= nowMs())
      return json(res, 409, { error:'poll_closed', message:'投票已截止' });
    const body = parseJson(await readBody(req));
    if (!body) return json(res, 400, { error:'bad_json' });
    const opt = poll.options.find(o => o.id === body.optionId);
    if (!opt) return json(res, 400, { error:'bad_option', message:'选项不存在' });
    poll.votes[u.id] = opt.id;
    return json(res, 200, { ok:true, poll: publicPoll(poll, u.id) });
  }

  if (req.method === 'PATCH' && (m = p.match(/^\/api\/polls\/([^/]+)\/deadline$/))){
    const u = currentUser(req);
    if (!u) return json(res, 401, { error:'not_authenticated', message:'请先切换到有效身份' });
    const poll = state.polls.find(x => x.id === m[1]);
    if (!poll) return json(res, 404, { error:'poll_not_found' });

    // 服务端独立校验：即便前端隐藏按钮，非发起人/已截止仍必须拒绝
    if (poll.ownerId !== u.id)
      return json(res, 403, { error:'not_owner', message:'仅投票发起人可修改截止时间' });
    if (new Date(poll.deadline).getTime() <= nowMs())
      return json(res, 409, { error:'poll_closed', message:'投票已截止，无法再修改截止时间' });

    const body = parseJson(await readBody(req));
    if (!body) return json(res, 400, { error:'bad_json' });
    const newIso = body.deadline;
    const t = newIso ? new Date(newIso).getTime() : NaN;
    if (!newIso || isNaN(t))
      return json(res, 400, { error:'bad_deadline', message:'截止时间格式不正确' });
    if (t <= nowMs())
      return json(res, 400, { error:'deadline_not_future', message:'新截止时间必须晚于当前时间' });

    // 失败保持原状态：以上任一失败分支都不改动 poll.deadline
    const oldDeadline = poll.deadline;
    poll.deadline = new Date(t).toISOString();
    poll.changeSeq += 1;

    // 只通知已投票成员；同一次修改（changeSeq）每人只写一条
    const voters = Object.keys(poll.votes);
    for (const v of voters){
      const key = `${v}:${poll.changeSeq}`;
      if (poll.notifiedFor[key]) continue;
      poll.notifiedFor[key] = true;
      state.notices[v] = state.notices[v] || [];
      state.notices[v].push({
        id: 'n_' + Math.random().toString(36).slice(2, 10),
        pollId: poll.id, changeSeq: poll.changeSeq,
        title: `投票『${poll.title}』截止时间已变更`,
        oldDeadline, newDeadline: poll.deadline,
        createdAt: new Date().toISOString(), read: false,
      });
    }
    return json(res, 200, { ok:true, poll: publicPoll(poll, u.id) });
  }

  if (req.method === 'POST' && p === '/api/reset'){
    state = seed();
    return json(res, 200, { ok:true });
  }

  json(res, 404, { error:'not_found', path: p });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    try { json(res, 500, { error:'internal', message: String(err && err.message || err) }); }
    catch { /* ignore */ }
  });
});

server.listen(PORT, () => {
  console.log(`[poll-deadline] listening on http://127.0.0.1:${PORT}`);
});
