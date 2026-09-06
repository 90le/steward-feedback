// Snooze Reminder Prototype — backend demo (Node 24, built-ins only)
// PRD Issue #10 v3. In-memory mock data. No external services, no host writes.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

// ---------------- mock data ----------------
const messages = [
  { id: 'm1', from: 'Manager', text: '@alice @bob 请下午确认季度目标 KPI 清单。', mentions: ['alice','bob'] },
  { id: 'm2', from: 'Manager', text: '@alice 麻烦看下 v3 PRD 反馈。',            mentions: ['alice'] },
  { id: 'm3', from: 'Carol',   text: '@bob 帮忙 review PR #42。',                mentions: ['bob'] },
  { id: 'm4', from: 'Bob',     text: '大家午饭一起？',                          mentions: [] },
  { id: 'm5', from: 'Manager', text: '@carol 请安排周会议程。',                  mentions: ['carol'] },
];

const reminders = (() => {
  const out = []; let n = 1;
  for (const m of messages) for (const uid of m.mentions) {
    out.push({ id: 'r' + (n++), uid, msgId: m.id, status: 'active', snoozeUntil: null, createdAt: Date.now() });
  }
  return out;
})();

const KNOWN_USERS = new Set(['alice','bob','carol']);

// ---------------- helpers ----------------
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > 65536) { req.destroy(); reject(new Error('too large')); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function realNow() { return Date.now(); } // server always uses its own clock as truth
function authUid(req) {
  const uid = String(req.headers['x-uid'] || '').toLowerCase();
  return KNOWN_USERS.has(uid) ? uid : null;
}
function findReminder(id) { return reminders.find(r => r.id === id); }

// Materialize snoozed -> active transitions when queried or acted on.
function tick() {
  const now = realNow();
  for (const r of reminders) {
    if (r.status === 'snoozed' && r.snoozeUntil && r.snoozeUntil <= now) {
      r.status = 'active'; r.snoozeUntil = null;
    }
  }
}

// ---------------- api ----------------
async function handleApi(req, res, opPath) {
  const uid = authUid(req);
  if (!uid) return json(res, 401, { ok: false, code: 'UNAUTHENTICATED', error: '未提供有效身份' });

  if (opPath === 'health') return json(res, 200, { ok: true, now: realNow() });

  if (opPath === 'list') {
    tick();
    const mine = reminders.filter(r => r.uid === uid);
    const enriched = mine.map(r => ({ ...r, message: messages.find(m => m.id === r.msgId) || null }));
    return json(res, 200, { ok: true, serverNow: realNow(), reminders: enriched });
  }

  if (opPath === 'messages') {
    return json(res, 200, { ok: true, messages });
  }

  let payload = {};
  try { payload = await readBody(req); } catch { return json(res, 400, { ok: false, code: 'BAD_BODY', error: '请求体解析失败' }); }

  const r = findReminder(payload.id);
  if (!r) return json(res, 404, { ok: false, code: 'NOT_FOUND', error: '提醒不存在' });
  // R6/AC9: server-side ownership check — do not rely on frontend.
  if (r.uid !== uid) return json(res, 403, { ok: false, code: 'FORBIDDEN', error: '仅本人可操作此提醒' });

  tick();
  const now = realNow();

  if (opPath === 'setSnooze' || opPath === 'editSnooze') {
    const until = Number(payload.until);
    if (!Number.isFinite(until)) return json(res, 400, { ok: false, code: 'BAD_TIME', error: '时间无效', serverNow: now });
    if (until <= now) return json(res, 400, { ok: false, code: 'NOT_FUTURE', error: '再次提醒时间必须晚于当前时间', serverNow: now });
    if (opPath === 'editSnooze' && r.status !== 'snoozed') {
      return json(res, 409, { ok: false, code: 'NOT_SNOOZED', error: '当前不处于延后状态', serverNow: now });
    }
    if (r.status === 'resolved') {
      return json(res, 409, { ok: false, code: 'ALREADY_DONE', error: '已处理的提醒不可再延后', serverNow: now });
    }
    r.status = 'snoozed';
    r.snoozeUntil = until;
    return json(res, 200, { ok: true, serverNow: now, reminder: r });
  }

  if (opPath === 'cancelSnooze') {
    if (r.status !== 'snoozed') return json(res, 409, { ok: false, code: 'NOT_SNOOZED', error: '当前不处于延后状态' });
    r.status = 'active'; r.snoozeUntil = null;
    return json(res, 200, { ok: true, reminder: r });
  }

  if (opPath === 'resolve') {
    if (r.status === 'resolved') return json(res, 409, { ok: false, code: 'ALREADY_DONE', error: '已经处理过' });
    // R9: resolve during snooze cancels the pending re-emergence.
    r.status = 'resolved'; r.snoozeUntil = null;
    return json(res, 200, { ok: true, reminder: r });
  }

  // R10 illustration: an explicit "view" action does NOT change state.
  if (opPath === 'view') {
    return json(res, 200, { ok: true, reminder: r, viewedAt: now });
  }

  // Failure injection endpoint for AC8 manual testing.
  if (opPath === 'fail') {
    return json(res, 500, { ok: false, code: 'INJECTED', error: '模拟失败' });
  }

  return json(res, 404, { ok: false, code: 'UNKNOWN_OP', error: '未知操作' });
}

// ---------------- static index.html ----------------
async function serveIndex(res) {
  try {
    let html = await readFile(join(__dirname, 'index.html'), 'utf8');
    // Inject data-api="1" so the frontend knows to call /api/*.
    html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-api="1">');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('index.html 读取失败：' + e.message);
  }
}

// ---------------- server ----------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/' && req.method === 'GET') return serveIndex(res);
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (pathname.startsWith('/api/')) {
    const op = pathname.slice('/api/'.length).replace(/\/+$/, '');
    if (req.method === 'GET' && (op === 'health' || op === 'list' || op === 'messages')) {
      return handleApi(req, res, op);
    }
    if (req.method === 'POST') {
      return handleApi(req, res, op);
    }
    return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('[snooze-prototype] listening on http://localhost:' + PORT);
});

// graceful shutdown
for (const sig of ['SIGINT','SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
