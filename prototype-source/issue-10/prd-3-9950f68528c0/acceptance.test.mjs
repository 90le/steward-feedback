// Independent acceptance tests for snooze reminder prototype (PRD #10 v3).
// Uses Node built-ins only. Reads CANDIDATE_DIR, spawns server.mjs, hits HTTP on 127.0.0.1.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CANDIDATE_DIR = process.env.CANDIDATE_DIR;
assert.ok(CANDIDATE_DIR, 'CANDIDATE_DIR env is required');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let child, baseUrl;

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: CANDIDATE_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  // wait for readiness by polling /api/health
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`, { headers: { 'x-uid': 'alice' } });
      if (r.ok) { await r.json(); return; }
    } catch { /* not ready */ }
    await delay(100);
  }
  throw new Error('server did not become ready within 8s');
});

after(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise(res => child.once('exit', res));
  }
});

async function api(method, path, { uid, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (uid) headers['x-uid'] = uid;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, raw: text };
}

async function listFor(uid) {
  const r = await api('GET', '/api/list', { uid });
  assert.equal(r.status, 200, `list ${uid} status`);
  return r.body.reminders;
}

// -------- Tests --------

test('README/server exist and expose expected endpoints', async () => {
  const readme = await readFile(join(CANDIDATE_DIR, 'README.md'), 'utf8');
  assert.ok(/\/api\/setSnooze/.test(readme));
  assert.ok(/\/api\/list/.test(readme));
  assert.ok(/x-uid/.test(readme));
});

test('AC1 + AC3 setSnooze hides from active, expiring returns as active/unresolved on next list', async () => {
  // Pick alice's first active reminder
  const before = await listFor('alice');
  const target = before.find(r => r.status === 'active');
  assert.ok(target, 'alice should have at least one active reminder');
  const originalMsgId = target.msgId;

  // Set snooze to ~150ms in future so we can observe re-emergence
  const until = Date.now() + 150;
  const set = await api('POST', '/api/setSnooze', { uid: 'alice', body: { id: target.id, until } });
  assert.equal(set.status, 200, 'setSnooze status');
  assert.equal(set.body.ok, true);
  assert.equal(set.body.reminder.status, 'snoozed');
  assert.equal(set.body.reminder.snoozeUntil, until);

  // Immediately: should NOT appear as active in list
  const midList = await listFor('alice');
  const midEntry = midList.find(r => r.id === target.id);
  assert.ok(midEntry, 'reminder still visible in owner list');
  assert.equal(midEntry.status, 'snoozed', 'reminder is snoozed (not active) during window');

  // Wait past snoozeUntil
  await delay(300);
  const afterList = await listFor('alice');
  const afterEntry = afterList.find(r => r.id === target.id);
  assert.ok(afterEntry, 'reminder re-appears after due');
  assert.equal(afterEntry.status, 'active', 'reminder returns to active (unresolved) after due');
  assert.equal(afterEntry.snoozeUntil, null, 'snoozeUntil cleared after materialization');
  // Message linkage preserved for "定位到原消息" R3/AC3
  assert.equal(afterEntry.msgId, originalMsgId, 'msgId preserved so client can locate original message');
  assert.ok(afterEntry.message && afterEntry.message.id === originalMsgId, 'list enriches with original message payload');
});

test('AC7/AC13 setSnooze with until <= serverNow rejected with NOT_FUTURE and serverNow, state preserved', async () => {
  const list = await listFor('alice');
  const target = list.find(r => r.status === 'active');
  assert.ok(target, 'need an active reminder for alice');
  const preStatus = target.status;

  const past = Date.now() - 1000;
  const r = await api('POST', '/api/setSnooze', { uid: 'alice', body: { id: target.id, until: past } });
  assert.equal(r.status, 400, 'past time rejected 400');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'NOT_FUTURE');
  assert.ok(typeof r.body.serverNow === 'number', 'serverNow returned so client can align');

  // Now = same instant: still rejected (must be strictly future)
  const now = Date.now();
  const r2 = await api('POST', '/api/setSnooze', { uid: 'alice', body: { id: target.id, until: now } });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'NOT_FUTURE');

  // State preserved
  const listAfter = await listFor('alice');
  const after = listAfter.find(x => x.id === target.id);
  assert.equal(after.status, preStatus, 'status unchanged after failed setSnooze');
  assert.equal(after.snoozeUntil, null, 'no snoozeUntil written on failure');
});

test('AC9 ownership: cannot snooze another user\'s reminder, forbidden and no state change', async () => {
  // Find a bob reminder
  const bobList = await listFor('bob');
  const bobTarget = bobList.find(r => r.status === 'active' || r.status === 'snoozed');
  assert.ok(bobTarget, 'bob should have a reminder');
  const preStatus = bobTarget.status;
  const preUntil = bobTarget.snoozeUntil;

  const until = Date.now() + 60_000;
  const r = await api('POST', '/api/setSnooze', { uid: 'alice', body: { id: bobTarget.id, until } });
  assert.equal(r.status, 403, 'foreign snooze forbidden');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'FORBIDDEN');

  // Alice's own list does not contain bob's reminder
  const aliceList = await listFor('alice');
  assert.equal(aliceList.find(x => x.id === bobTarget.id), undefined, 'alice list does not leak bob reminders');

  // Bob's state unchanged
  const bobList2 = await listFor('bob');
  const bobAfter = bobList2.find(x => x.id === bobTarget.id);
  assert.equal(bobAfter.status, preStatus, 'bob reminder status unchanged');
  assert.equal(bobAfter.snoozeUntil, preUntil, 'bob snoozeUntil unchanged');
});

test('Unauthenticated (no x-uid) rejected with 401', async () => {
  const r = await api('GET', '/api/list');
  assert.equal(r.status, 401);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'UNAUTHENTICATED');
});

test('AC10 resolve during snooze cancels re-emergence; AC11 view does not change state', async () => {
  // Get a fresh reminder for carol (isolated from alice manipulations)
  const carolList = await listFor('carol');
  const target = carolList.find(r => r.status === 'active');
  assert.ok(target, 'carol has an active reminder');

  // Snooze in the future (short window)
  const until1 = Date.now() + 200;
  const s = await api('POST', '/api/setSnooze', { uid: 'carol', body: { id: target.id, until: until1 } });
  assert.equal(s.status, 200);
  assert.equal(s.body.reminder.status, 'snoozed');

  // AC11: /api/view should NOT change status/snoozeUntil
  const v = await api('POST', '/api/view', { uid: 'carol', body: { id: target.id } });
  assert.equal(v.status, 200);
  assert.equal(v.body.reminder.status, 'snoozed', 'view keeps snoozed status');
  assert.equal(v.body.reminder.snoozeUntil, until1, 'view keeps snoozeUntil');

  // AC10: resolve during snooze -> cancels re-emergence
  const res = await api('POST', '/api/resolve', { uid: 'carol', body: { id: target.id } });
  assert.equal(res.status, 200);
  assert.equal(res.body.reminder.status, 'resolved');
  assert.equal(res.body.reminder.snoozeUntil, null);

  // Wait past original snoozeUntil and ensure it did NOT re-emerge as active
  await delay(400);
  const listAfter = await listFor('carol');
  const entry = listAfter.find(x => x.id === target.id);
  assert.ok(entry, 'reminder still listed');
  assert.equal(entry.status, 'resolved', 'resolved reminder never returns to active after original snoozeUntil');
});

test('AC4/AC5 editSnooze requires snoozed state; cancelSnooze restores active', async () => {
  // Fresh alice reminder that is currently active
  const list = await listFor('alice');
  const target = list.find(r => r.status === 'active');
  assert.ok(target, 'need active reminder for alice');

  // editSnooze on non-snoozed -> 409 NOT_SNOOZED
  const bad = await api('POST', '/api/editSnooze', { uid: 'alice', body: { id: target.id, until: Date.now() + 60_000 } });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'NOT_SNOOZED');

  // Snooze first
  const untilA = Date.now() + 60_000;
  const s = await api('POST', '/api/setSnooze', { uid: 'alice', body: { id: target.id, until: untilA } });
  assert.equal(s.status, 200);

  // Now edit to another future time
  const untilB = Date.now() + 120_000;
  const e = await api('POST', '/api/editSnooze', { uid: 'alice', body: { id: target.id, until: untilB } });
  assert.equal(e.status, 200);
  assert.equal(e.body.reminder.status, 'snoozed');
  assert.equal(e.body.reminder.snoozeUntil, untilB);

  // Cancel
  const c = await api('POST', '/api/cancelSnooze', { uid: 'alice', body: { id: target.id } });
  assert.equal(c.status, 200);
  assert.equal(c.body.reminder.status, 'active');
  assert.equal(c.body.reminder.snoozeUntil, null);

  // Verify via list
  const listAfter = await listFor('alice');
  const entry = listAfter.find(x => x.id === target.id);
  assert.equal(entry.status, 'active');
  assert.equal(entry.snoozeUntil, null);
});

test('AC8 injected failure keeps state unchanged; non-existent id gives 404', async () => {
  // Non-existent id => 404 NOT_FOUND
  const nf = await api('POST', '/api/setSnooze', { uid: 'alice', body: { id: 'does-not-exist', until: Date.now() + 60_000 } });
  assert.equal(nf.status, 404);
  assert.equal(nf.body.code, 'NOT_FOUND');

  // /api/fail returns 500 without touching any reminder's state
  const preList = await listFor('bob');
  const anyBob = preList[0];
  assert.ok(anyBob);
  const fail = await api('POST', '/api/fail', { uid: 'bob', body: { id: anyBob.id } });
  assert.equal(fail.status, 500);
  assert.equal(fail.body.ok, false);
  assert.equal(fail.body.code, 'INJECTED');

  const postList = await listFor('bob');
  const postEntry = postList.find(x => x.id === anyBob.id);
  assert.equal(postEntry.status, anyBob.status, 'fail injection did not change status');
  assert.equal(postEntry.snoozeUntil, anyBob.snoozeUntil, 'fail injection did not change snoozeUntil');
});

test('GET / serves data-api HTML shell (front-end backend-bound flag)', async () => {
  const r = await fetch(`${baseUrl}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /data-api="1"/);
  assert.match(html, /<html/);
});
