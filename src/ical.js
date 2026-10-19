// src/ical.js — minimal VCALENDAR parser + RRULE expander → busy blocks.
// Pure ESM: no bun/node/browser deps. Shared by `bun test`, the server,
// and (through the agent reply) the browser UI.
//
// A busy block: { start, end, title, source, uid?, external: true }
// start/end are local 'YYYY-MM-DDTHH:MM' strings like Docket's own events.

const p2 = (n) => String(n).padStart(2, '0');

export function fmtLocal(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Wall-clock in `tzid` → local Date. Uses Intl; falls back to floating. */
export function wallToLocal(y, mo, da, h, mi, tzid) {
  const utcGuess = Date.UTC(y, mo - 1, da, h, mi);
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = (t) => Object.fromEntries(
      dtf.formatToParts(new Date(t)).map((x) => [x.type, x.value])
    );
    // Solve: find utc ms t such that the wall clock at tzid(t) matches input.
    let t = utcGuess;
    for (let i = 0; i < 3; i++) {
      const q = parts(t);
      const shown = Date.UTC(+q.year, +q.month - 1, +q.day, q.hour === '24' ? 0 : +q.hour, +q.minute, +q.second);
      t = t + (utcGuess - shown);
    }
    return new Date(t);
  } catch {
    return new Date(y, mo - 1, da, h, mi); // floating fallback
  }
}

/** Parse a DT value with its params → local Date. */
export function parseIcalDt(value, params) {
  let m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(?:(\d{2}))?(Z)?)?$/);
  if (!m) return null;
  const [, ys, mos, das, hs, mis] = m;
  const y = +ys, mo = +mos - 1, da = +das, h = +(hs || 0), mi = +(mis || 0);
  if (params.VALUE === 'DATE') return new Date(y, mo, da); // all-day
  if (m[7] === 'Z') return new Date(Date.UTC(y, mo, da, h, mi)); // UTC
  if (params.TZID) return wallToLocal(y, mo + 1, da, h, mi, params.TZID);
  return new Date(y, mo, da, h, mi); // floating → server-local
}

function parseProp(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const nameParams = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = nameParams.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const [k, ...rest] = p.split('=');
    params[k.toUpperCase()] = rest.join('=').replace(/^"(.*)"$/, '$1');
  }
  return { name, params, value };
}

function unfold(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

function parseRrule(value) {
  const out = {};
  for (const pair of value.split(';')) {
    const [k, v] = pair.split('=');
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out;
}

/**
 * Parse ICS text → normalized events:
 * [{ uid, title, start: Date(local), end: Date(local), allDay, rrule }]
 */
export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(String(text || '')).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (t === 'END:VEVENT') { if (cur && cur.dtstart) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseProp(t);
    if (!p) continue;
    if (p.name === 'UID') cur.uid = p.value.trim();
    else if (p.name === 'SUMMARY') cur.title = p.value.replace(/\\(.)/g, '$1').trim();
    else if (p.name === 'DTSTART') {
      cur.dtstart = parseIcalDt(p.value.trim(), p.params);
      cur.allDay = p.params.VALUE === 'DATE';
    } else if (p.name === 'DTEND') {
      cur.dtend = parseIcalDt(p.value.trim(), p.params);
    } else if (p.name === 'RRULE') {
      cur.rrule = parseRrule(p.value.trim());
    }
  }
  const out = [];
  for (const e of events) {
    const start = e.dtstart;
    if (!(start instanceof Date) || isNaN(start)) continue;
    let end = e.dtend instanceof Date && !isNaN(e.dtend) ? e.dtend : null;
    if (!end) end = e.allDay ? new Date(start.getTime() + 86400000) : new Date(start.getTime() + 3600000);
    if (end <= start) end = new Date(start.getTime() + 3600000);
    out.push({
      uid: e.uid || '', title: e.title || 'Busy', start, end,
      allDay: !!e.allDay, rrule: e.rrule || null,
    });
  }
  return out;
}

/**
 * Expand parsed events into busy blocks within [from, to] (local Date range).
 * RRULE: FREQ=DAILY / FREQ=WEEKLY (COUNT/UNTIL honored), bounded by a guard.
 * Returns [{ start, end, title, source, uid, external: true }] with local
 * 'YYYY-MM-DDTHH:MM' strings.
 */
export function expandIcal(events, from, to, source) {
  const blocks = [];
  for (const e of events) {
    const dur = e.end.getTime() - e.start.getTime();
    const emit = (d) => {
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), e.start.getHours(), e.start.getMinutes());
      const t = new Date(s.getTime() + dur);
      if (t <= from || s >= to) return;
      blocks.push({
        start: fmtLocal(s), end: fmtLocal(t),
        title: e.title, source, uid: e.uid, external: true,
      });
    };
    const freq = e.rrule?.FREQ;
    if (!freq || (freq !== 'DAILY' && freq !== 'WEEKLY')) {
      if (e.end > from && e.start < to) {
        blocks.push({
          start: fmtLocal(e.start), end: fmtLocal(e.end),
          title: e.title, source, uid: e.uid, external: true,
        });
      }
      continue;
    }
    const until = e.rrule.UNTIL ? parseIcalDt(e.rrule.UNTIL, {}) : null;
    const count = e.rrule.COUNT ? Number(e.rrule.COUNT) : Infinity;
    const untilDate = e.rrule.UNTIL ? (until || to) : to;
    const s0 = e.start;
    let n = 0, guard = 0;
    let d = new Date(s0);
    while (d < to && d <= untilDate && n < count && guard++ < 800) {
      if (new Date(d.getTime() + dur) > from) emit(d);
      n++;
      d = new Date(s0.getFullYear(), s0.getMonth(), s0.getDate() + (freq === 'DAILY' ? n : n * 7), s0.getHours(), s0.getMinutes());
    }
  }
  return blocks;
}

/**
 * Merge overlapping busy blocks (used across all sources before the agent
 * reasons about time). Overlaps coalesce; titles join with ' + ' and source
 * labels are kept from the earliest block.
 */
export function mergeBusyBlocks(blocks) {
  const toMin = (s) => {
    const [d, tm] = s.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = tm.split(':').map(Number);
    return new Date(y, mo - 1, da, h, mi).getTime() / 60000;
  };
  const fromMin = (m) => fmtLocal(new Date(m * 60000));
  const iv = blocks
    .map((b) => ({ s: toMin(b.start), e: toMin(b.end), b }))
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const x of iv) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) {
      last.e = Math.max(last.e, x.e);
      if (!last.b.title.includes(x.b.title)) last.b.title += ' + ' + x.b.title;
    } else {
      out.push({ s: x.s, e: x.e, b: { ...x.b } });
    }
  }
  return out.map(({ s, e, b }) => ({ ...b, start: fromMin(s), end: fromMin(e) }));
}
