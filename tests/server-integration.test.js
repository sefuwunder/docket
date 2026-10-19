// tests/server-integration.test.js — real HTTP against a spawned server.
// Seeds a local event, points the iCal URL at a local fixture ICS server,
// then exercises ?external=1, ext: mutation rejection, and POST /api/sync.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';

const DIR = '/home/hatch/workspace/your_files/docket';
const PORT = 43771;
const BASE = `http://127.0.0.1:${PORT}`;

let server, icsSrv, icsUrl;

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:fix-standup',
  'SUMMARY:External standup',
  'DTSTART:20261020T140000Z',
  'DTEND:20261020T150000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

beforeAll(async () => {
  // fresh DB so counts are deterministic (data/ is gitignored, never pushed)
  rmSync(`${DIR}/data`, { recursive: true, force: true });
  icsSrv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(ICS, { headers: { 'content-type': 'text/calendar' } }),
  });
  icsUrl = `http://127.0.0.1:${icsSrv.port}/feed.ics`;
  server = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/events`); break; }
    catch { await Bun.sleep(100); }
  }
});

afterAll(() => {
  try { server.kill(); } catch { /* gone */ }
  try { icsSrv.stop(); } catch { /* gone */ }
});

describe('GET /api/events?external=1', () => {
  test('merges local events and external busy blocks with ext: ids', async () => {
    const seeded = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: 'Local lunch', start: '2026-10-20T12:00', end: '2026-10-20T13:00' }),
    });
    expect(seeded.status).toBe(201);

    const set = await api('/api/settings', { method: 'POST', body: JSON.stringify({ icalUrl: icsUrl }) });
    expect(set.status).toBe(200);
    expect(set.body.ical.configured).toBe(true);
    // the URL must never leak back to the client
    expect(JSON.stringify(set.body)).not.toContain('feed.ics');

    const r = await api('/api/events?from=2026-10-19&to=2026-10-21&external=1');
    expect(r.status).toBe(200);
    const local = r.body.find((e) => e.title === 'Local lunch');
    const ext = r.body.find((e) => e.title === 'External standup');
    expect(local).toBeTruthy();
    expect(typeof local.id).toBe('number');
    expect(ext).toBeTruthy();
    expect(ext.id).toBe('ext:fix-standup');
    expect(ext.external).toBe(true);
    expect(ext.source).toBe('iCal feed');
    expect(ext.start.slice(0, 10)).toBe('2026-10-20');
    // sorted by start
    const starts = r.body.map((e) => e.start);
    expect([...starts].sort()).toEqual(starts);
  });

  test('without external=1, only local events are returned', async () => {
    const r = await api('/api/events?from=2026-10-19&to=2026-10-21');
    expect(r.status).toBe(200);
    expect(r.body.some((e) => String(e.id).startsWith('ext:'))).toBe(false);
    expect(r.body.some((e) => e.title === 'Local lunch')).toBe(true);
  });
});

describe('ext: mutation rejection', () => {
  test('PUT on ext: id → 409', async () => {
    const r = await api('/api/events/ext:fix-standup', {
      method: 'PUT',
      body: JSON.stringify({ title: 'Hacked', start: '2026-10-20T14:00', end: '2026-10-20T15:00' }),
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/read-only/);
  });

  test('DELETE on ext: id → 409', async () => {
    const r = await api('/api/events/ext:fix-standup', { method: 'DELETE' });
    expect(r.status).toBe(409);
  });

  test('POST with ext: id in body → 400', async () => {
    const r = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ id: 'ext:fix-standup', title: 'X', start: '2026-10-20T14:00', end: '2026-10-20T15:00' }),
    });
    expect(r.status).toBe(400);
  });

  test('external event is still listed after the rejections', async () => {
    const r = await api('/api/events?from=2026-10-19&to=2026-10-21&external=1');
    expect(r.body.some((e) => e.id === 'ext:fix-standup')).toBe(true);
  });
});

describe('POST /api/sync', () => {
  test('returns real statuses: ical synced with count, honest GOA note', async () => {
    const r = await api('/api/sync', { method: 'POST' });
    expect(r.status).toBe(200);
    const ical = r.body.accountStatus.find((s) => s.id === 'ical');
    expect(ical).toBeTruthy();
    expect(ical.status).toBe('synced');
    expect(ical.count).toBeGreaterThanOrEqual(1);
    expect(r.body.count).toBeGreaterThanOrEqual(1);
    // no GOA daemon in this sandbox → honest note, not a fake "synced"
    expect(r.body.note || '').toContain('GNOME accounts unreachable');
  });

  test('settings GET still never leaks the URL', async () => {
    const r = await api('/api/settings');
    expect(JSON.stringify(r.body)).not.toContain('feed.ics');
  });

  test('clearing the URL removes external blocks', async () => {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ icalUrl: '' }) });
    const r = await api('/api/events?from=2026-10-19&to=2026-10-21&external=1');
    expect(r.body.some((e) => String(e.id).startsWith('ext:'))).toBe(false);
  });
});
