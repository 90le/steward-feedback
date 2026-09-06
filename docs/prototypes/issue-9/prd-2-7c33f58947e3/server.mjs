// 群置顶到期自动取消 · 演示后端（Node 24 内置模块）
// 仅用于本地原型联调；不接真实用户系统，不写宿主，不调用外部服务。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

// 模拟身份表；后端独立校验，不信任前端禁按钮
const USERS = {
  admin:  { id: 'admin',  name: 'Alice', canPin: true  },
  admin2: { id: 'admin2', name: 'Bob',   canPin: true  },
  member: { id: 'member', name: 'Carol', canPin: false }
};

// 内存中的模拟消息
let seq = 100;
const now = Date.now();
const messages = [
  { id: 1, author: 'Alice', text: '欢迎大家加入本群，欢迎多多交流～',      pinned: false, expireAt: null, createdAt: now - 3600000*24 },
  { id: 2, author: 'Alice', text: '【长期公告】本群禁止广告，违者移出。',    pinned: true,  expireAt: null, createdAt: now - 3600000*10 },
  { id: 3, author: 'Bob',   text: '【本周分享】周五 20:00 线上分享，主题：Node 24 新特性。',
    pinned: true, expireAt: now + 60000, createdAt: now - 1800000 }
];

// 定期扫描：仅按时间到达触发；不删除、不通知
function sweep() {
  const t = Date.now();
  for (const m of messages) {
    if (m.pinned && m.expireAt != null && m.expireAt <= t) {
      m.pinned = false;
      m.expireAt = null;
      // 静默：无通知、无系统消息
    }
  }
}
const sweepTimer = setInterval(sweep, 1000);
sweepTimer.unref?.();

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      buf += c;
      if (buf.length > 1024 * 32) { // 32KB 上限
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function whoami(req) {
  const uid = req.headers['x-user-id'];
  if (typeof uid === 'string' && Object.prototype.hasOwnProperty.call(USERS, uid)) {
    return USERS[uid];
  }
  return null;
}

function findMsg(id) {
  return messages.find(m => m.id === id) || null;
}

function publicMsg(m) {
  return { id: m.id, author: m.author, text: m.text, pinned: m.pinned, expireAt: m.expireAt, createdAt: m.createdAt };
}

async function handle(req, res) {
  // 极简 CORS/安全头：本原型固定同源
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  // 静态：GET / → 注入 data-api="1"
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = await readFile(join(__dirname, 'index.html'), 'utf8');
      const injected = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-api="1">');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(injected);
    } catch (e) {
      json(res, 500, { error: { code: 'read_index_failed', message: String(e.message || e) } });
    }
    return;
  }

  if (method === 'GET' && p === '/api/health') {
    sweep();
    return json(res, 200, {
      ok: true,
      now: Date.now(),
      messages: messages.length,
      pinned: messages.filter(m => m.pinned).length
    });
  }

  // 除了 /api/health 与 /，其余 /api/** 需要身份
  if (p.startsWith('/api/')) {
    sweep(); // 每次请求先扫过期
    const user = whoami(req);
    if (!user) return json(res, 401, { error: { code: 'unauthenticated', message: '缺少或未知的身份（X-User-Id）' } });

    if (method === 'GET' && p === '/api/messages') {
      return json(res, 200, { messages: messages.map(publicMsg) });
    }

    if (method === 'POST' && p === '/api/messages') {
      let body;
      try { body = await readBody(req); }
      catch (e) { return json(res, 400, { error: { code: e.message || 'bad_request', message: '请求体解析失败' } }); }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const pin = !!body.pin;
      const expireAt = body.expireAt == null ? null : Number(body.expireAt);
      if (!text) return json(res, 400, { error: { code: 'invalid_text', message: '消息内容不能为空' } });
      if (pin && !user.canPin) return json(res, 403, { error: { code: 'forbidden', message: '当前身份没有置顶权限' } });
      if (pin && expireAt != null) {
        if (!Number.isFinite(expireAt)) return json(res, 400, { error: { code: 'invalid_expire', message: '到期时间格式非法' } });
        if (expireAt <= Date.now()) return json(res, 400, { error: { code: 'invalid_expire', message: '到期时间必须晚于当前时间' } });
      }
      const m = {
        id: ++seq,
        author: user.name,
        text,
        pinned: pin,
        expireAt: pin ? (expireAt || null) : null,
        createdAt: Date.now()
      };
      messages.push(m);
      return json(res, 200, { message: publicMsg(m) });
    }

    // /api/messages/:id/pin  POST { pin: bool }
    let m1 = p.match(/^\/api\/messages\/(\d+)\/pin$/);
    if (m1 && method === 'POST') {
      const id = parseInt(m1[1], 10);
      const msg = findMsg(id);
      if (!msg) return json(res, 404, { error: { code: 'not_found', message: '消息不存在' } });
      if (!user.canPin) return json(res, 403, { error: { code: 'forbidden', message: '没有置顶权限' } });
      let body;
      try { body = await readBody(req); }
      catch { return json(res, 400, { error: { code: 'bad_request', message: '请求体解析失败' } }); }
      const pin = !!body.pin;
      // 失败保护语义：先决定新值副本，全部校验通过再落库
      const nextPinned = pin;
      const nextExpire = pin ? msg.expireAt : null;
      msg.pinned = nextPinned;
      msg.expireAt = nextExpire;
      return json(res, 200, { message: publicMsg(msg) });
    }

    // /api/messages/:id/expire  PUT { expireAt: number|null }
    let m2 = p.match(/^\/api\/messages\/(\d+)\/expire$/);
    if (m2 && method === 'PUT') {
      const id = parseInt(m2[1], 10);
      const msg = findMsg(id);
      if (!msg) return json(res, 404, { error: { code: 'not_found', message: '消息不存在' } });
      if (!user.canPin) return json(res, 403, { error: { code: 'forbidden', message: '没有置顶权限' } });
      if (!msg.pinned) return json(res, 409, { error: { code: 'not_pinned', message: '该消息未处于置顶状态' } });
      let body;
      try { body = await readBody(req); }
      catch { return json(res, 400, { error: { code: 'bad_request', message: '请求体解析失败' } }); }
      const expireAt = body.expireAt == null ? null : Number(body.expireAt);
      if (expireAt != null) {
        if (!Number.isFinite(expireAt)) return json(res, 400, { error: { code: 'invalid_expire', message: '到期时间格式非法' } });
        if (expireAt <= Date.now()) return json(res, 400, { error: { code: 'invalid_expire', message: '到期时间必须晚于当前时间' } });
      }
      // 校验都通过再写入；上一状态在校验失败路径不会被改动
      msg.expireAt = expireAt;
      return json(res, 200, { message: publicMsg(msg) });
    }

    return json(res, 404, { error: { code: 'not_found', message: '接口不存在' } });
  }

  json(res, 404, { error: { code: 'not_found', message: 'not found' } });
}

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    try { json(res, 500, { error: { code: 'server_error', message: String(err && err.message || err) } }); }
    catch { /* ignore */ }
  });
});

server.listen(PORT, () => {
  console.log(`[prototype] listening on http://127.0.0.1:${PORT}`);
});
