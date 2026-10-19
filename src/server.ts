// src/server.ts — Docket: Bun + bun:sqlite, REST API + static UI + agent endpoint.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import {
  parseMessage, detectConflicts, findFreeSlots, expandAll, matchEvents,
  formatTime, formatDay, HELP_TEXT, fmtDate, addDays,
  fromMin, toMin, upcomingWeekday,
} from './agent.js';
import { collectExternalBusy, invalidateCache, listGoaCalendarAccounts, redactIdentity } from './external.js';

const PORT = Number(process.env.PORT || 3037);
const HOST = process.env.HOST || '127.0.0.1';
const COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'gray'];

mkdirSync('data', { recursive: true });
const db = new Database('data/docket.db');
db.run(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  location TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  color TEXT DEFAULT 'blue',
  rrule TEXT,
  rrule_until TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

const getSetting = (key: string): string | null => {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
  return row ? row.value : null;
};
const setSetting = (key: string, value: string) => {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
};
const externalSettings = () => ({
  icalUrl: getSetting('ical_url') || undefined,
  goaEnabled: getSetting('goa_enabled') !== '0',
});

type StoredEvent = {
  id: number; title: string; start: string; end: string;
  location: string; notes: string; color: string;
  rrule: string | null; rrule_until: string | null;
};

const allStored = (): StoredEvent[] =>
  db.query('SELECT * FROM events ORDER BY start').all() as StoredEvent[];

function expanded(from: string, to: string) {
  return expandAll(allStored(), from, to).sort((a, b) =>
    a.start < b.start ? -1 : 1
  );
}

function validateEvent(b: any): string | null {
  if (!b.title || !String(b.title).trim()) return 'title is required';
  if (!b.start || !b.end) return 'start and end are required';
  if (toMin(b.start) >= toMin(b.end)) return 'end must be after start';
  if (b.color && !COLORS.includes(b.color)) return 'unknown color';
  if (b.rrule && !['daily', 'weekly', 'weekdays'].includes(b.rrule)) return 'unknown rrule';
  return null;
}

function insertEvent(b: any): StoredEvent {
  const r = db.query(
    `INSERT INTO events (title, start, end, location, notes, color, rrule, rrule_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(
    String(b.title).trim(), b.start, b.end, b.location || '', b.notes || '',
    b.color || 'blue', b.rrule || null, b.rrule_until || null
  ) as StoredEvent;
  return r;
}

// ---------- agent ----------

type Chip = { label: string; action: any };
type AgentReply = { reply: string; chips?: Chip[]; refresh?: boolean };

const pending = new Map<string, { kind: 'delete' | 'move'; eventIds: number[]; eventId?: number; to?: { start: string; end: string } }>();
const rid = () => Math.random().toString(36).slice(2, 10);

function fmtRange(e: { start: string; end: string }, now: Date) {
  return `${formatDay(e.start.slice(0, 10), now)} ${formatTime(e.start)}–${formatTime(e.end)}`;
}

type ExtBlock = { start: string; end: string; title: string; source: string; external: boolean };

// External busy blocks for the day containing `date` (±1 day for cross-midnight).
async function externalForDate(date: string): Promise<{ blocks: ExtBlock[]; note: string | null }> {
  const from = new Date(date + 'T00:00:00');
  const to = new Date(addDays(date, 2) + 'T00:00:00');
  try {
    const r = await collectExternalBusy(externalSettings(), from, to);
    const blocks = (r.blocks as ExtBlock[]).filter((b) => b.start.slice(0, 10) === date);
    return { blocks, note: r.note };
  } catch {
    return { blocks: [], note: 'external calendars unavailable' };
  }
}

function externalNoteLine(note: string | null): string {
  return note ? `\n(External calendars unavailable right now — showing local only.)` : '';
}

/** "busy 2–3pm per your Google calendar" style name for an external block. */
function extName(b: { title: string; start: string; end: string; source: string }) {
  return `'${b.title}' (${formatTime(b.start)}–${formatTime(b.end)} per your ${b.source.toLowerCase()})`;
}

async function conflictReply(title: string, start: string, end: string, now: Date): Promise<AgentReply> {
  const date = start.slice(0, 10);
  const dayEvents = expanded(date, date);
  const ext = await externalForDate(date);
  const allBusy = dayEvents.concat(ext.blocks);
  const conflicts = detectConflicts(start, end, allBusy);
  const names = conflicts.map((c) =>
    c.external ? extName(c as any) : `'${c.title}' (${formatTime(c.start)}–${formatTime(c.end)})`
  ).join(', ');
  const alts = findFreeSlots(date, Math.round(toMin(end) - toMin(start)), allBusy, 9, 18, 3, toMin(start));
  const chips: Chip[] = alts.map((s) => ({
    label: formatTime(s.start),
    action: { type: 'create', event: { title, start: s.start, end: s.end } },
  }));
  return {
    reply: `That overlaps with ${names}. Nearest free times ${formatDay(date, now)}:` + externalNoteLine(ext.note),
    chips,
  };
}

async function handleAgentMessage(message: string, now: Date): Promise<AgentReply> {
  const p = parseMessage(message, now);

  if (p.intent === 'help') return { reply: HELP_TEXT };
  if (p.intent === 'unknown') {
    return { reply: `I didn't catch that. ${HELP_TEXT}` };
  }
  if (p.intent === 'abort') {
    pending.clear();
    return { reply: 'OK, dropped it.' };
  }
  if (p.intent === 'confirm') {
    return { reply: 'Tap one of the confirmation buttons above, or tell me what to do.' };
  }

  if (p.intent === 'query') {
    if (!p.date) return { reply: "Which day? Try 'what's on Friday?'." };
    const evs = expanded(p.date, p.date);
    const ext = await externalForDate(p.date);
    if (!evs.length && !ext.blocks.length) {
      return { reply: `Nothing on ${formatDay(p.date, now)} — clear.` + externalNoteLine(ext.note) };
    }
    const lines = evs.map((e) => `• ${formatTime(e.start)}–${formatTime(e.end)} ${e.title}`);
    const extLines = ext.blocks.map((b) => `• ${formatTime(b.start)}–${formatTime(b.end)} ${b.title} (${b.source.toLowerCase()}, read-only)`);
    const all = [...lines, ...extLines].join('\n');
    return { reply: `${formatDay(p.date, now)}:\n${all}` + externalNoteLine(ext.note) };
  }

  if (p.intent === 'findfree') {
    const evs = expanded(p.date, p.date);
    const ext = await externalForDate(p.date);
    const allBusy = evs.concat(ext.blocks);
    const slots = findFreeSlots(p.date, p.minutes, allBusy, p.window.start, p.window.end, 5);
    if (!slots.length) {
      return { reply: `No ${p.minutes}-minute gaps ${formatDay(p.date, now)} ${p.window.label === 'day' ? '' : 'in the ' + p.window.label}.` + externalNoteLine(ext.note) };
    }
    const chips: Chip[] = slots.slice(0, 3).map((s) => ({
      label: `${formatTime(s.start)}`,
      action: { type: 'book', start: s.start, end: s.end },
    }));
    const list = slots.slice(0, 5).map((s) => formatTime(s.start)).join(', ');
    return { reply: `Free ${formatDay(p.date, now)}${p.window.label === 'day' ? '' : ' ' + p.window.label}: ${list}. Tap one to book it:` + externalNoteLine(ext.note), chips };
  }

  if (p.intent === 'create') {
    let date = p.date;
    if (p.recurrence === 'weekly' && p.recurrenceWeekday != null) {
      date = upcomingWeekday(now, p.recurrenceWeekday);
    }
    const start = `${date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const end = fromMin(toMin(start) + p.minutes);
    const dayEvents = expanded(date, date);
    const ext = await externalForDate(date);
    const conflicts = detectConflicts(start, end, dayEvents.concat(ext.blocks));
    if (conflicts.length) {
      return conflictReply(p.title, start, end, now);
    }
    const ev = insertEvent({ title: p.title, start, end, rrule: p.recurrence });
    const rec = p.recurrence ? ` (${p.recurrence})` : '';
    return {
      reply: `Done: '${ev.title}' ${fmtRange(ev, now)}${rec}.` + externalNoteLine(ext.note),
      refresh: true,
    };
  }

  if (p.intent === 'cancel') {
    const from = fmtDate(now), to = addDays(from, 60);
    const matches = matchEvents(p.titleQuery, expanded(from, to), now);
    if (!matches.length) return { reply: `I couldn't find anything matching '${p.titleQuery}' in the next 60 days. (Events from external calendars are read-only — edit those in your own calendar app.)` };
    if (matches.length > 1) {
      const chips: Chip[] = matches.slice(0, 4).map((e) => {
        const id = rid();
        pending.set(id, { kind: 'delete', eventIds: [e.occurrenceOf ?? e.id] });
        return { label: `${e.title} · ${fmtRange(e, now)}`, action: { type: 'confirm', confirmId: id } };
      });
      return { reply: `Which one?`, chips };
    }
    const e = matches[0];
    const id = rid();
    pending.set(id, { kind: 'delete', eventIds: [e.occurrenceOf ?? e.id] });
    return {
      reply: `Delete '${e.title}' ${fmtRange(e, now)}?`,
      chips: [{ label: 'Yes, delete it', action: { type: 'confirm', confirmId: id } }],
    };
  }

  if (p.intent === 'move') {
    if (!p.date) return { reply: `Move it to when? Try 'move dentist to Thursday'.` };
    const from = fmtDate(now), to = addDays(from, 60);
    const matches = matchEvents(p.titleQuery, expanded(from, to), now);
    if (!matches.length) return { reply: `I couldn't find anything matching '${p.titleQuery}' in the next 60 days. (Events from external calendars are read-only — edit those in your own calendar app.)` };
    const pick = (e: any): AgentReply => {
      const durMin = Math.round(toMin(e.end) - toMin(e.start));
      const hh = p.hour != null ? p.hour : Number(e.start.slice(11, 13));
      const mm = p.minute != null ? p.minute : Number(e.start.slice(14, 16));
      const start = `${p.date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      const end = fromMin(toMin(start) + durMin);
      const id = rid();
      pending.set(id, { kind: 'move', eventIds: [], eventId: e.occurrenceOf ?? e.id, to: { start, end } });
      return {
        reply: `Move '${e.title}' to ${fmtRange({ start, end }, now)}?`,
        chips: [{ label: 'Yes, move it', action: { type: 'confirm', confirmId: id } }],
      };
    };
    if (matches.length > 1) {
      return {
        reply: `Which one should I move to ${formatDay(p.date!, now)}?`,
        chips: matches.slice(0, 4).map((e) => ({
          label: `${e.title} · ${fmtRange(e, now)}`,
          action: { type: 'pickmove', pickId: e.occurrenceOf ?? e.id, date: p.date, hour: p.hour, minute: p.minute },
        })),
      };
    }
    return pick(matches[0]);
  }

  return { reply: HELP_TEXT };
}

async function handleConfirm(confirmId: string, now: Date): Promise<AgentReply> {
  const p = pending.get(confirmId);
  if (!p) return { reply: 'That confirmation expired — tell me again?' };
  pending.delete(confirmId);
  if (p.kind === 'delete') {
    for (const id of p.eventIds) db.run('DELETE FROM events WHERE id = ?', [id]);
    return { reply: 'Deleted.', refresh: true };
  }
  if (p.kind === 'move' && p.eventId && p.to) {
    const row = db.query('SELECT * FROM events WHERE id = ?').get(p.eventId) as StoredEvent | null;
    if (!row) return { reply: 'That event is gone already.' };
    const ext = await externalForDate(p.to.start.slice(0, 10));
    const conflicts = detectConflicts(p.to.start, p.to.end, expanded(p.to.start.slice(0, 10), p.to.start.slice(0, 10)).concat(ext.blocks), p.eventId);
    if (conflicts.length) {
      return conflictReply(row.title, p.to.start, p.to.end, now);
    }
    db.run('UPDATE events SET start = ?, end = ?, updated_at = datetime(\'now\') WHERE id = ?', [p.to.start, p.to.end, p.eventId]);
    return { reply: `Moved '${row.title}' to ${fmtRange(p.to, now)}.`, refresh: true };
  }
  return { reply: 'Nothing to confirm.' };
}

// ---------- http ----------

/** Settings status for the client: masked, never includes secrets. */
async function settingsStatus() {
  const icalConfigured = !!(getSetting('ical_url') || '').trim();
  let goaAccounts: { id: string; identity: string; provider: string }[] = [];
  try {
    goaAccounts = (await listGoaCalendarAccounts()).map((a: any) => ({
      id: a.id,
      identity: redactIdentity(a.identity),
      provider: a.providerName,
    }));
  } catch { /* GOA unreachable — list stays empty, quiet */ }
  return {
    ical: { configured: icalConfigured },
    goaEnabled: getSetting('goa_enabled') !== '0',
    goa: goaAccounts,
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveStatic(pathname: string): Promise<Response | null> {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel.includes('..')) return null;
  // also serve /src/* (shared agent module) from the project src dir
  const roots = ['public', '.'];
  for (const root of roots) {
    const f = Bun.file(`${root}/${rel}`);
    if (await f.exists()) {
      const ext = '.' + rel.split('.').pop()!;
      return new Response(f, { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
    }
  }
  return null;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const now = new Date();

    try {
      // ----- events API -----
      if (pathname === '/api/events' && req.method === 'GET') {
        const from = url.searchParams.get('from') || fmtDate(now);
        const to = url.searchParams.get('to') || addDays(from, 62);
        return Response.json(expanded(from, to));
      }
      if (pathname === '/api/events' && req.method === 'POST') {
        const b = await req.json();
        const err = validateEvent(b);
        if (err) return Response.json({ error: err }, { status: 400 });
        const force = url.searchParams.get('force') === '1';
        if (!force) {
          const conflicts = detectConflicts(b.start, b.end, expanded(b.start.slice(0, 10), b.start.slice(0, 10)));
          if (conflicts.length) {
            return Response.json({ error: 'conflict', conflicts }, { status: 409 });
          }
        }
        return Response.json(insertEvent(b), { status: 201 });
      }
      let m = pathname.match(/^\/api\/events\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const b = await req.json();
        const row = db.query('SELECT * FROM events WHERE id = ?').get(m[1]) as StoredEvent | null;
        if (!row) return Response.json({ error: 'not found' }, { status: 404 });
        const next = { ...row, ...b, id: Number(m[1]) };
        const err = validateEvent(next);
        if (err) return Response.json({ error: err }, { status: 400 });
        db.run(
          `UPDATE events SET title=?, start=?, end=?, location=?, notes=?, color=?, rrule=?, rrule_until=?, updated_at=datetime('now') WHERE id=?`,
          [next.title, next.start, next.end, next.location, next.notes, next.color, next.rrule, next.rrule_until, next.id]
        );
        return Response.json(next);
      }
      if (m && req.method === 'DELETE') {
        const r = db.run('DELETE FROM events WHERE id = ?', [m[1]]);
        // bun:sqlite run returns {changes}; use query for count safety
        return Response.json({ deleted: m[1] });
      }
      // ----- agent -----
      if (pathname === '/api/agent' && req.method === 'POST') {
        const b = await req.json();
        if (b.confirmId) {
          return Response.json(await handleConfirm(String(b.confirmId), now));
        }
        if (b.pickmove) {
          // second step of ambiguous move: {pickId, date, hour, minute}
          const row = db.query('SELECT * FROM events WHERE id = ?').get(b.pickmove.pickId) as StoredEvent | null;
          if (!row) return Response.json({ reply: 'That event is gone already.' });
          const durMin = Math.round(toMin(row.end) - toMin(row.start));
          const hh = b.pickmove.hour != null ? b.pickmove.hour : Number(row.start.slice(11, 13));
          const mm = b.pickmove.minute != null ? b.pickmove.minute : Number(row.start.slice(14, 16));
          const start = `${b.pickmove.date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
          const end = fromMin(toMin(start) + durMin);
          const id = rid();
          pending.set(id, { kind: 'move', eventIds: [], eventId: row.id, to: { start, end } });
          return Response.json({
            reply: `Move '${row.title}' to ${fmtRange({ start, end }, now)}?`,
            chips: [{ label: 'Yes, move it', action: { type: 'confirm', confirmId: id } }],
          });
        }
        if (!b.message || !String(b.message).trim()) {
          return Response.json({ reply: HELP_TEXT });
        }
        return Response.json(await handleAgentMessage(String(b.message), now));
      }
      // ----- settings (secrets stay server-side; GET never returns them) -----
      if (pathname === '/api/settings' && req.method === 'GET') {
        return Response.json(await settingsStatus());
      }
      if (pathname === '/api/settings' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        if ('icalUrl' in b) {
          const v = String(b.icalUrl || '').trim();
          setSetting('ical_url', v);
          invalidateCache();
        }
        if ('goaEnabled' in b) {
          setSetting('goa_enabled', b.goaEnabled ? '1' : '0');
          invalidateCache();
        }
        return Response.json(await settingsStatus());
      }

      // ----- static -----
      const st = await serveStatic(pathname);
      if (st) return st;
      return new Response('not found', { status: 404 });
    } catch (e: any) {
      console.error(e);
      return Response.json({ error: String(e?.message || e) }, { status: 500 });
    }
  },
});

console.log(`docket on http://${HOST}:${PORT}`);
