// server.mjs — Octo 提醒 · 稍后再提醒（snooze）原型后端
// 只使用 Node 内置模块。仅内存中的模拟数据，不接入真实用户系统。
// 提供：
//   GET  /                          -> 返回 index.html，注入 <html data-api="1">
//   GET  /api/health                -> 健康检查
//   GET  /api/reminders             -> 列出 X-Acting-User 所属提醒
//   POST /api/reminders/:id/snooze  -> 设置/修改稍后再提醒
//   POST /api/reminders/:id/cancel  -> 取消延后
//   POST /api/reminders/:id/done    -> 明确标记为已处理
//   GET  /api/reminders/:id/message -> 获取原消息内容与所在会话切片
// 身份来自 X-Acting-User 头，仅用于模拟；u_alice 与 u_alice2 都映射到本人 u_alice。
// 服务器持有权威时间与状态；失败保持原状态。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;

// ---------- Mock state ----------
const CHAT = [
  { id: 'm1', from: '张经理', time: '10:02', body: '下周一路演材料请大家 @Alice @Bob 帮忙确认。' },
  { id: 'm2', from: '李工',   time: '10:05', body: '@Alice 帮忙看下附件里的接口字段。' },
  { id: 'm3', from: '小丘',   time: '10:07', body: '公告：会议室 3 号 15:00 空闲。' },
  { id: 'm4', from: '张经理', time: '10:12', body: '@Bob 麻烦确认下发布节奏。' },
  { id: 'm5', from: '李工',   time: '10:20', body: '@Alice 顺便帮忙订下午茶，谢谢。' }
];

const ACTING_TO_USER = { u_alice: 'u_alice', u_alice2: 'u_alice', u_bob: 'u_bob' };
const KNOWN_USERS = new Set(['u_alice', 'u_bob']);

const reminders = new Map();
function seed() {
  const now = Date.now();
  const list = [
    { id: 'r_a_1', ownerId: 'u_alice', messageId: 'm2', fromName: '李工',   createdAt: now-600000, snoozeUntil: null, done: false },
    { id: 'r_a_2', ownerId: 'u_alice', messageId: 'm5', fromName: '李工',   createdAt: now-120000, snoozeUntil: null, done: false },
    { id: 'r_b_1', ownerId: 'u_bob',   messageId: 'm1', fromName: '张经理', createdAt: now-900000, snoozeUntil: null, done: false },
    { id: 'r_b_2', ownerId: 'u_bob',   messageId: 'm4', fromName: '张经理', createdAt: now-300000, snoozeUntil: null, done: false }
  ];
  for (const r of list) reminders.set(r.id, r);
}
seed();

function normalize(r, now) {
  const expired = r.snoozeUntil && r.snoozeUntil <= now;
  return {
    id: r.id,
    ownerId: r.ownerId,
    messageId: r.messageId,
    fromName: r.fromName,
    createdAt: r.createdAt,
    snoozeUntil: r.snoozeUntil,
    done: r.done,
    state: r.done ? 'done' : (r.snoozeUntil && !expired ? 'snoozed' : 'active'),
    expired: !!expired
  };
}

// ---------- HTTP helpers ----------
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function parseUrlPath(rawUrl) {
  // Only accept simple paths per sandbox rules; ignore query/hash.
  const q = rawUrl.indexOf('?');
  const h = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return rawUrl.slice(0, end);
}

async function readJsonBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function resolveActing(req) {
  const raw = req.headers['x-acting-user'];
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const owner = ACTING_TO_USER[raw];
  if (!owner || !KNOWN_USERS.has(owner)) return null;
  return { actingId: raw, ownerId: owner };
}

// ---------- Routes ----------
async function handle(req, res) {
  const method = req.method || 'GET';
  const path = parseUrlPath(req.url || '/');

  if (method === 'GET' && path === '/') {
    try {
      const p = join(__dirname, 'index.html');
      let html = await readFile(p, 'utf8');
      // Inject data-api="1" attribute
      if (/<html\b/i.test(html)) {
        html = html.replace(/<html\b([^>]*)>/i, (m, attrs) => {
          if (/\bdata-api\s*=/.test(attrs)) return m;
          return `<html${attrs} data-api="1">`;
        });
      }
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    } catch (e) {
      return sendText(res, 500, 'index.html 读取失败：' + (e?.message || e));
    }
  }

  if (method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { ok: true, now: Date.now(), reminders: reminders.size });
  }

  // All /api/* below require identity
  if (path.startsWith('/api/')) {
    const who = resolveActing(req);
    if (!who && path !== '/api/health') {
      return sendJson(res, 401, { ok: false, error: '缺少或非法 X-Acting-User 身份头' });
    }

    if (method === 'GET' && path === '/api/reminders') {
      const now = Date.now();
      const mine = [...reminders.values()]
        .filter((r) => r.ownerId === who.ownerId)
        .map((r) => normalize(r, now));
      return sendJson(res, 200, { ok: true, now, actingId: who.actingId, ownerId: who.ownerId, reminders: mine });
    }

    // /api/reminders/:id/(snooze|cancel|done|message)
    const parts = path.split('/'); // ['', 'api', 'reminders', ':id', 'op']
    if (parts.length === 5 && parts[1] === 'api' && parts[2] === 'reminders') {
      const rid = parts[3];
      const op = parts[4];
      if (!/^[A-Za-z0-9_-]+$/.test(rid) || rid.length > 64) {
        return sendJson(res, 400, { ok: false, error: '提醒 ID 非法' });
      }
      const r = reminders.get(rid);
      if (!r) return sendJson(res, 404, { ok: false, error: '提醒不存在' });
      if (r.ownerId !== who.ownerId) {
        return sendJson(res, 403, { ok: false, error: '只能操作本人的提醒（R6/AC9）' });
      }

      if (op === 'snooze' && method === 'POST') {
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return sendJson(res, 400, { ok: false, error: e.message || '请求体解析失败' }); }
        const until = Number(body?.snoozeUntil);
        const now = Date.now();
        if (!Number.isFinite(until)) {
          return sendJson(res, 400, { ok: false, error: '缺少或非法的 snoozeUntil（毫秒时间戳）', now });
        }
        if (r.done) {
          return sendJson(res, 409, { ok: false, error: '提醒已被标记为已处理，无法再延后', now });
        }
        if (until <= now) {
          return sendJson(res, 400, {
            ok: false,
            error: `再次提醒时间必须晚于当前服务器时间 ${new Date(now).toISOString()}（AC7/AC13/AC18）`,
            now
          });
        }
        r.snoozeUntil = until;
        return sendJson(res, 200, { ok: true, now, reminder: normalize(r, now) });
      }

      if (op === 'cancel' && method === 'POST') {
        const now = Date.now();
        r.snoozeUntil = null;
        return sendJson(res, 200, { ok: true, now, reminder: normalize(r, now) });
      }

      if (op === 'done' && method === 'POST') {
        const now = Date.now();
        r.done = true;
        r.snoozeUntil = null; // R9：明确处理即取消延后
        return sendJson(res, 200, { ok: true, now, reminder: normalize(r, now) });
      }

      if (op === 'message' && method === 'GET') {
        const now = Date.now();
        const msg = CHAT.find((m) => m.id === r.messageId);
        if (!msg) return sendJson(res, 404, { ok: false, error: '原消息不存在或已删除' });
        // R5/AC6：仅读取，不改动原消息，不修改提醒状态
        return sendJson(res, 200, {
          ok: true,
          now,
          message: msg,
          chat: CHAT,
          snapshotAt: now
        });
      }

      return sendJson(res, 405, { ok: false, error: '方法或操作不受支持' });
    }

    return sendJson(res, 404, { ok: false, error: 'API 路径不存在' });
  }

  return sendText(res, 404, 'Not found');
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { sendJson(res, 500, { ok: false, error: '服务器内部错误：' + (e?.message || e) }); }
    catch { /* ignore */ }
  });
});
server.listen(PORT, () => {
  console.log(`[snooze-prototype] listening on http://127.0.0.1:${PORT}`);
});
