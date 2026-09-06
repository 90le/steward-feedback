// Snooze 演示后端 —— Node 内置模块，只处理内存中的模拟数据。
// 不接真实用户系统、不读宿主配置、不写盘、不联网。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ------- In-memory mock data -------
const USERS = { u_alice: 'Alice', u_bob: 'Bob' };

function seed() {
  const now = Date.now();
  return {
    messages: [
      { id: 'm_1', author: 'Carol', text: '@Alice 麻烦看下昨天的报表格式', ts: now - 600000 },
      { id: 'm_2', author: 'Dave',  text: '大家好，午饭一起？',           ts: now - 500000 },
      { id: 'm_3', author: 'Carol', text: '@Bob 帮忙 review 一下 PR',     ts: now - 400000 },
      { id: 'm_4', author: 'Eve',   text: '@Alice @Bob 周会挪到下午 3 点', ts: now - 300000 },
    ],
    reminders: [
      { id: 'r_a1', userId: 'u_alice', messageId: 'm_1', status: 'active', snoozeUntil: null, createdAt: now - 600000 },
      { id: 'r_a2', userId: 'u_alice', messageId: 'm_4', status: 'active', snoozeUntil: null, createdAt: now - 300000 },
      { id: 'r_b1', userId: 'u_bob',   messageId: 'm_3', status: 'active', snoozeUntil: null, createdAt: now - 400000 },
      { id: 'r_b2', userId: 'u_bob',   messageId: 'm_4', status: 'active', snoozeUntil: null, createdAt: now - 300000 },
    ],
  };
}
let store = seed();

function materialize(r) {
  const now = Date.now();
  const copy = { ...r };
  if (copy.status === 'snoozed' && copy.snoozeUntil && copy.snoozeUntil <= now) {
    copy.viewStatus = 'active';
    copy.reemerged = true;
  } else {
    copy.viewStatus = copy.status;
    copy.reemerged = false;
  }
  return copy;
}

function ok(data) { return { ok: true, data: { serverNow: Date.now(), ...data } }; }
function err(code, msg, extra) { return { ok: false, error: { code, msg, serverNow: Date.now(), ...(extra || {}) } }; }

function isValidUser(u) { return typeof u === 'string' && Object.prototype.hasOwnProperty.call(USERS, u); }

function handleList(uid) {
  const list = store.reminders.filter(r => r.userId === uid).map(materialize);
  return ok({ reminders: list });
}
function findMine(uid, reminderId) {
  const r = store.reminders.find(x => x.id === reminderId);
  if (!r) return { error: err('not_found', '提醒不存在') };
  if (r.userId !== uid) return { error: err('forbidden', '不能对他人的提醒操作') };
  return { r };
}
function handleSnooze(uid, body) {
  const f = findMine(uid, body.reminderId);
  if (f.error) return f.error;
  const r = f.r;
  if (r.status === 'done') return err('invalid_state', '该提醒已处理');
  const until = Number(body.snoozeUntil);
  if (!Number.isFinite(until) || until <= Date.now()) return err('time_invalid', '再次提醒时间必须晚于当前时间');
  r.status = 'snoozed'; r.snoozeUntil = until;
  return ok({ reminder: materialize(r) });
}
function handleCancelSnooze(uid, body) {
  const f = findMine(uid, body.reminderId);
  if (f.error) return f.error;
  const r = f.r;
  if (r.status !== 'snoozed') return err('invalid_state', '仅延后中的提醒可取消延后');
  r.status = 'active'; r.snoozeUntil = null;
  return ok({ reminder: materialize(r) });
}
function handleMarkDone(uid, body) {
  const f = findMine(uid, body.reminderId);
  if (f.error) return f.error;
  const r = f.r;
  // 允许对 active 或 snoozed 明确标记为已处理；已处理则幂等返回
  r.status = 'done'; r.snoozeUntil = null;
  return ok({ reminder: materialize(r) });
}
function handleViewMessage(uid, body) {
  const f = findMine(uid, body.reminderId);
  if (f.error) return f.error;
  const r = f.r;
  const m = store.messages.find(x => x.id === r.messageId);
  if (!m) return err('not_found', '原消息不存在');
  // 仅查看，不改变提醒任何状态
  return ok({ message: m, conversation: store.messages });
}
function handleReset() { store = seed(); return ok({}); }

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 65536) { req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const OPS = {
  list: handleList,
  snooze: handleSnooze,
  cancelSnooze: handleCancelSnooze,
  markDone: handleMarkDone,
  viewMessage: handleViewMessage,
  reset: handleReset,
};

async function serveIndex(res) {
  try {
    const raw = await readFile(join(__dirname, 'index.html'), 'utf8');
    // 注入 data-api="1" 以便前端切换到联调模式
    const injected = raw.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-api="1">');
    const body = Buffer.from(injected, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: { code: 'index_missing', msg: 'index.html 读取失败: ' + e.message } });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // GET /
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveIndex(res);
    }
    // Health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, ok({ status: 'ok' }));
    }
    // API
    if (url.pathname.startsWith('/api/')) {
      const op = url.pathname.slice('/api/'.length);
      if (!Object.prototype.hasOwnProperty.call(OPS, op)) {
        return sendJson(res, 404, err('unknown_op', '未知接口: ' + op));
      }
      if (req.method !== 'POST') {
        return sendJson(res, 405, err('method_not_allowed', '需要 POST'));
      }
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, err('bad_request', e.message)); }
      // 身份来自 header/body，服务端自行校验，不信任前端禁按钮
      const uid = String(req.headers['x-acting-user'] || body.actingUserId || '');
      if (op !== 'reset' && !isValidUser(uid)) {
        return sendJson(res, 401, err('unauthenticated', '未识别的模拟用户'));
      }
      let result;
      try {
        result = OPS[op](uid, body);
      } catch (e) {
        return sendJson(res, 500, err('internal', e.message));
      }
      const status = result.ok ? 200
        : result.error && result.error.code === 'not_found' ? 404
        : result.error && result.error.code === 'forbidden' ? 403
        : result.error && result.error.code === 'unauthenticated' ? 401
        : 400;
      return sendJson(res, status, result);
    }
    // 404
    sendJson(res, 404, err('not_found', 'Not Found: ' + url.pathname));
  } catch (e) {
    sendJson(res, 500, err('internal', e.message));
  }
});

server.listen(PORT, () => {
  console.log('[snooze-demo] listening on http://127.0.0.1:' + PORT);
});

// 便于自测：SIGTERM 平滑关闭
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
