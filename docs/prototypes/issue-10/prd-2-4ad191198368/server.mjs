// Octo 提醒 · snooze 原型演示后端
// 只使用 Node 内置模块；无外部依赖；只操作内存数据。
// 启动：PORT=3000 node server.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, 'index.html');
const PORT = Number(process.env.PORT || 3000);

// ==== 模拟内存数据 ====
// 与前端本地模拟保持一致的字段。
// 注意：仅演示用途，不接入真实用户系统，进程重启即丢失。
function initialData() {
  return [
    { id:'r1', userId:'u1', messageId:'m100', text:'张三 @你：会议纪要请今晚补齐', createdAt: Date.parse('2026-09-06T19:30:00'), status:'active' },
    { id:'r2', userId:'u1', messageId:'m101', text:'李四 @你：麻烦帮忙 review PR', createdAt: Date.parse('2026-09-06T19:45:00'), status:'active' },
    { id:'r3', userId:'u1', messageId:'m102', text:'王五 @你：客户反馈需要回复', createdAt: Date.parse('2026-09-06T19:55:00'), status:'active' },
    { id:'r4', userId:'u2', messageId:'m100', text:'张三 @你：会议纪要请今晚补齐', createdAt: Date.parse('2026-09-06T19:30:00'), status:'active' },
    { id:'r5', userId:'u2', messageId:'m200', text:'赵六 @你：设计稿评审', createdAt: Date.parse('2026-09-06T19:20:00'), status:'active' },
    { id:'r6', userId:'u3', messageId:'m100', text:'张三 @你：会议纪要请今晚补齐', createdAt: Date.parse('2026-09-06T19:30:00'), status:'active' }
  ];
}
const KNOWN_USERS = new Set(['u1','u2','u3']);
let reminders = initialData();

// ==== 工具 ====
function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) { req.destroy(); reject(new Error('BODY_TOO_LARGE')); } });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function nowFromReq(req, url) {
  // 允许前端传入 "模拟当前时间"，方便测试到点重现。
  const q = url.searchParams.get('now');
  const h = req.headers['x-now'];
  const v = q ?? h;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return Date.now();
}
function whoami(req) {
  const u = req.headers['x-user-id'];
  if (typeof u === 'string' && KNOWN_USERS.has(u)) return u;
  return null;
}
function derive(r, now) {
  if (r.status === 'done') return 'done';
  if (r.snoozeUntil && r.snoozeUntil > now) return 'snoozed';
  return 'active';
}
function projection(r, now) {
  const v = derive(r, now);
  return { ...r, view: v };
}

// ==== 业务动作 ====
function getOwned(id, userId) {
  const r = reminders.find(x => x.id === id);
  if (!r) return { status: 404, err: { code:'NOT_FOUND', message:'提醒不存在' } };
  if (r.userId !== userId) return { status: 403, err: { code:'FORBIDDEN', message:'不能对他人的提醒执行此操作' } };
  return { r };
}

// ==== HTTP 路由 ====
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    // 前端页面：注入 data-api="1" 标记，前端据此启用 fetch 联调
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html = await readFile(INDEX_PATH, 'utf8');
      html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-api="1">');
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type':'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control':'no-store'
      });
      res.end(body);
      return;
    }

    // Health
    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, mode:'prototype', now: Date.now(), reminders: reminders.length });
    }

    // 列表
    if (req.method === 'GET' && path === '/api/reminders') {
      const userId = url.searchParams.get('userId');
      if (!userId || !KNOWN_USERS.has(userId)) return send(res, 400, { code:'BAD_USER', message:'未知用户' });
      const now = nowFromReq(req, url);
      const list = reminders.filter(r => r.userId === userId).map(r => projection(r, now));
      return send(res, 200, { now, reminders: list });
    }

    // 单条业务动作
    // /api/reminders/:id/snooze  POST 设置/修改；DELETE 取消
    // /api/reminders/:id/done    POST 明确标记已处理
    // /api/reminders/:id/undone  POST 恢复未处理（原型用，便于回归测试）
    // /api/reminders/:id/view    POST 仅查看原消息（不改变处理/延后状态，R10）
    // /api/reset                 POST 重置数据（原型用）
    if (req.method === 'POST' && path === '/api/reset') {
      reminders = initialData();
      return send(res, 200, { ok: true });
    }

    const m = path.match(/^\/api\/reminders\/([^/]+)\/(snooze|done|undone|view)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const userId = whoami(req);
      if (!userId) return send(res, 401, { code:'UNAUTHENTICATED', message:'缺少或非法的身份头 X-User-Id' });
      const now = nowFromReq(req, url);

      if (action === 'view') {
        // 仅查看：不做处理/延后变化。仍需属于本人（R6/R11）。
        const g = getOwned(id, userId);
        if (g.err) return send(res, g.status, g.err);
        g.r.viewedAt = now;
        return send(res, 200, { ok:true, reminder: projection(g.r, now) });
      }

      if (action === 'snooze' && req.method === 'POST') {
        const body = await readJson(req).catch(e => ({ __err: e.message }));
        if (body.__err) return send(res, 400, { code:'BAD_JSON', message:'请求体格式错误' });
        const until = Number(body.until);
        if (!Number.isFinite(until)) return send(res, 400, { code:'BAD_TIME', message:'缺少或非法的 until' });
        const g = getOwned(id, userId);
        if (g.err) return send(res, g.status, g.err);
        if (g.r.status === 'done') return send(res, 409, { code:'ALREADY_DONE', message:'该提醒已处理，无法设置延后' });
        // 服务端独立时间校验（R8/AC7），不依赖前端
        if (!(until > now)) return send(res, 400, { code:'INVALID_TIME', message:'再次提醒时间必须晚于当前时间' });
        g.r.snoozeUntil = until;
        return send(res, 200, { ok:true, reminder: projection(g.r, now) });
      }
    }

    // /api/reminders/:id/snooze DELETE
    const m2 = path.match(/^\/api\/reminders\/([^/]+)\/snooze$/);
    if (m2 && req.method === 'DELETE') {
      const id = decodeURIComponent(m2[1]);
      const userId = whoami(req);
      if (!userId) return send(res, 401, { code:'UNAUTHENTICATED', message:'缺少或非法的身份头 X-User-Id' });
      const now = nowFromReq(req, url);
      const g = getOwned(id, userId);
      if (g.err) return send(res, g.status, g.err);
      if (!g.r.snoozeUntil) return send(res, 409, { code:'NO_SNOOZE', message:'该提醒当前未设置延后' });
      delete g.r.snoozeUntil;
      return send(res, 200, { ok:true, reminder: projection(g.r, now) });
    }

    // POST done / undone
    const m3 = path.match(/^\/api\/reminders\/([^/]+)\/(done|undone)$/);
    if (m3 && req.method === 'POST') {
      const id = decodeURIComponent(m3[1]);
      const action = m3[2];
      const userId = whoami(req);
      if (!userId) return send(res, 401, { code:'UNAUTHENTICATED', message:'缺少或非法的身份头 X-User-Id' });
      const now = nowFromReq(req, url);
      const g = getOwned(id, userId);
      if (g.err) return send(res, g.status, g.err);
      if (action === 'done') {
        g.r.status = 'done';
        // R9：明确处理即取消延后
        delete g.r.snoozeUntil;
      } else {
        g.r.status = 'active';
      }
      return send(res, 200, { ok:true, reminder: projection(g.r, now) });
    }

    return send(res, 404, { code:'NOT_FOUND', message:'路由不存在' });
  } catch (e) {
    return send(res, 500, { code:'SERVER_ERR', message: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[snooze-prototype] listening on http://127.0.0.1:${PORT}`);
});
