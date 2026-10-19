// src/agent.js — Docket scheduling agent: deterministic NL parser + free-time
// finder + conflict logic. Pure ESM: no bun/node/browser deps, importable by
// `bun test`, the Bun server, and the browser UI alike.
//
// Dates are plain local calendar dates ('YYYY-MM-DD'); datetimes are local
// ISO-ish strings ('YYYY-MM-DDTHH:MM'). All functions take an explicit `now`
// (a Date) so tests can pin time.

export const WORK_START = 9; // working-hours window for free-time search
export const WORK_END = 18;
export const DEFAULT_DURATION_MIN = 60;

const DAY_NAMES = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday',
];
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8,
  oct: 9, nov: 10, dec: 11,
};

// ---------- date helpers (local time) ----------

export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

export function dayNameOf(dateStr) {
  return DAY_NAMES[parseDateStr(dateStr).getDay()];
}

/** Nearest upcoming weekday (today counts if it matches). */
export function upcomingWeekday(now, targetIdx) {
  const delta = (targetIdx - now.getDay() + 7) % 7;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
  return fmtDate(d);
}

/** The <weekday> of the current Sun-Sat week; rolls +7 if already past. */
export function thisWeekday(now, targetIdx) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - d.getDay() + targetIdx);
  const todayStr = fmtDate(now);
  let s = fmtDate(d);
  if (s < todayStr) s = addDays(s, 7);
  return s;
}

/** "next <weekday>" = this week's one, plus 7 days. */
export function nextWeekday(now, targetIdx) {
  return addDays(thisWeekday(now, targetIdx), 7);
}

export function weekdayIdx(name) {
  return DAY_NAMES.indexOf(name.toLowerCase());
}

// ---------- extraction ----------

/** Extract a calendar date from free text. Returns {date, matched} or null. */
export function extractDate(text, now) {
  const t = text.toLowerCase();
  const todayStr = fmtDate(now);

  let m = t.match(/\bday after tomorrow\b/);
  if (m) return { date: addDays(todayStr, 2), matched: m[0] };
  m = t.match(/\btomorrow\b/);
  if (m) return { date: addDays(todayStr, 1), matched: m[0] };
  m = t.match(/\btoday\b/);
  if (m) return { date: todayStr, matched: m[0] };

  // "next Friday" / "this Friday" / bare "Friday"
  m = t.match(/\b(next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (m) {
    const idx = weekdayIdx(m[2]);
    const date = m[1] === 'next' ? nextWeekday(now, idx) : thisWeekday(now, idx);
    return { date, matched: m[0] };
  }
  m = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (m) {
    return { date: upcomingWeekday(now, weekdayIdx(m[1])), matched: m[0] };
  }

  // "October 23" / "Oct 23" / "23rd of October" / "2026-10-23"
  m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    const month = MONTHS[m[1]];
    const day = Number(m[2]);
    let d = new Date(now.getFullYear(), month, day);
    if (fmtDate(d) < todayStr) d = new Date(now.getFullYear() + 1, month, day);
    return { date: fmtDate(d), matched: m[0] };
  }
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (m) {
    const month = MONTHS[m[2]];
    const day = Number(m[1]);
    let d = new Date(now.getFullYear(), month, day);
    if (fmtDate(d) < todayStr) d = new Date(now.getFullYear() + 1, month, day);
    return { date: fmtDate(d), matched: m[0] };
  }
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { date: m[0], matched: m[0] };

  return null;
}

/** Extract a time of day. Returns {hour, minute, matched} or null. */
export function extractTime(text) {
  const t = text.toLowerCase();
  let m = t.match(/\bnoon\b/);
  if (m) return { hour: 12, minute: 0, matched: m[0] };
  m = t.match(/\bmidnight\b/);
  if (m) return { hour: 0, minute: 0, matched: m[0] };
  m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let hour = Number(m[1]) % 12;
    if (m[3] === 'pm') hour += 12;
    return { hour, minute: Number(m[2] || 0), matched: m[0] };
  }
  m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return { hour: Number(m[1]), minute: Number(m[2]), matched: m[0] };
  return null;
}

/** Extract a duration in minutes. Returns {minutes, matched} or null. */
export function extractDuration(text) {
  const t = text.toLowerCase();
  let m = t.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(min|mins|minutes|hr|hrs|hour|hours)\b/);
  if (!m) m = t.match(/\b(\d+(?:\.\d+)?)\s*(min|mins|minutes|hr|hrs|hour|hours)\b/);
  if (m) {
    const n = Number(m[1]);
    const minutes = /hr|hour/.test(m[2]) ? Math.round(n * 60) : n;
    return { minutes, matched: m[0] };
  }
  return null;
}

/** Extract simple recurrence. Returns {rule, weekday?, matched} or null. */
export function extractRecurrence(text) {
  const t = text.toLowerCase();
  let m = t.match(/\bevery\s+weekdays?\b|\bweekdays\b/);
  if (m) return { rule: 'weekdays', matched: m[0] };
  m = t.match(/\bevery\s+day\b|\bdaily\b/);
  if (m) return { rule: 'daily', matched: m[0] };
  m = t.match(/\bevery\s+week\b|\bweekly\b/);
  if (m) return { rule: 'weekly', matched: m[0] };
  m = t.match(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (m) return { rule: 'weekly', weekday: weekdayIdx(m[1]), matched: m[0] };
  return null;
}

/** Part of day → [startHour, endHour] clipped to working hours. */
export function extractPartOfDay(text) {
  const t = text.toLowerCase();
  if (/\bmorning\b/.test(t)) return { start: WORK_START, end: 12, label: 'morning' };
  if (/\bafternoon\b/.test(t)) return { start: 12, end: 17, label: 'afternoon' };
  if (/\bevening\b/.test(t)) return { start: 17, end: WORK_END, label: 'evening' };
  return { start: WORK_START, end: WORK_END, label: 'day' };
}

// ---------- intent parsing ----------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMatches(text, matches) {
  let out = text;
  for (const m of matches) {
    if (!m) continue;
    // extractors match against lowercased text; strip case-insensitively
    out = out.replace(new RegExp(escapeRegExp(m), 'i'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Remove leading command verbs and stray prepositions from a title. */
export function cleanTitle(raw) {
  let s = raw
    .replace(/^(add|create|schedule|set up|set|new event|put)\b\s*/i, '')
    .replace(/\s*\b(at|on|from)\s*$/i, '')
    .replace(/^[\s,.;:]+|[\s,.;:]+$/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a chat message into an intent object.
 * intents: create | move | cancel | query | findfree | trainmodel | patterns |
 *   confirm | help | unknown
 */
export function parseMessage(text, now) {
  const t = text.trim();
  const low = t.toLowerCase();

  if (/^(hi|hello|hey|yo)\b/.test(low) || /\bhelp\b/.test(low)) {
    return { intent: 'help' };
  }
  if (/^(yes|yeah|yep|sure|confirm|do it|ok|okay)\b/.test(low)) {
    return { intent: 'confirm' };
  }
  if (/^(no|nope|cancel that|never ?mind)\b/.test(low)) {
    return { intent: 'abort' };
  }

  if (/\btrain\b.*\bmodel\b|\bretrain\b/.test(low)) {
    return { intent: 'trainmodel' };
  }
  if (/\bpatterns?\b/.test(low) || /\bcategorize my (week|month)\b/.test(low) || /\bwhat do you see\b/.test(low)) {
    return { intent: 'patterns' };
  }

  let m = low.match(/^(move|reschedule|shift|postpone)\s+(.+?)\s+to\s+(.+)$/);
  if (m) {
    const date = extractDate(m[3], now);
    const time = extractTime(m[3]);
    return {
      intent: 'move',
      titleQuery: cleanTitle(m[2]),
      date: date ? date.date : null,
      hour: time ? time.hour : null,
      minute: time ? time.minute : null,
    };
  }

  m = low.match(/^(cancel|delete|remove)\s+(?:my\s+|the\s+)?(.+)$/);
  if (m) {
    return { intent: 'cancel', titleQuery: cleanTitle(m[2]) };
  }

  m = low.match(/^(?:what'?s on|what do i have|show(?: me)?|do i have anything|anything on)\s+(.+?)[?.!]*$/);
  if (m) {
    const date = extractDate(m[1], now);
    return { intent: 'query', date: date ? date.date : null, raw: m[1] };
  }

  if (/(free|available)/.test(low) && /(find|when|am i|are you|look)/.test(low)) {
    const dur = extractDuration(t);
    const date = extractDate(t, now);
    const pod = extractPartOfDay(t);
    return {
      intent: 'findfree',
      date: date ? date.date : fmtDate(now),
      minutes: dur ? dur.minutes : 30,
      window: pod,
    };
  }

  // create (default): needs at least a date or time or recurrence
  const date = extractDate(t, now);
  const time = extractTime(t);
  const dur = extractDuration(t);
  const rec = extractRecurrence(t);
  if (date || time || rec) {
    const title = cleanTitle(
      stripMatches(t, [date && date.matched, time && time.matched, dur && dur.matched, rec && rec.matched])
        .replace(/\bevery\b/i, '')
    );
    return {
      intent: 'create',
      title: title || 'Untitled event',
      date: date ? date.date : fmtDate(now),
      hour: time ? time.hour : 9,
      minute: time ? time.minute : 0,
      timeGiven: !!time,
      minutes: dur ? dur.minutes : DEFAULT_DURATION_MIN,
      recurrence: rec ? rec.rule : null,
      recurrenceWeekday: rec && rec.weekday != null ? rec.weekday : null,
    };
  }

  return { intent: 'unknown' };
}

// ---------- events: overlap, conflicts, free time ----------

export function toMin(dt) {
  // 'YYYY-MM-DDTHH:MM' → minutes since epoch (local)
  const [d, tm] = dt.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = tm.split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi).getTime() / 60000;
}

export function fromMin(min) {
  const d = new Date(min * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return toMin(aStart) < toMin(bEnd) && toMin(bStart) < toMin(aEnd);
}

/** Return existing events overlapping [start, end). */
export function detectConflicts(start, end, events, excludeId = null) {
  return events.filter(
    (e) => e.id !== excludeId && overlaps(start, end, e.start, e.end)
  );
}

function mergeBusy(events) {
  const iv = events
    .map((e) => [toMin(e.start), toMin(e.end)])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Find free slots on `date` of at least `minutes` within [winStart, winEnd]
 * hours. `events` are expanded occurrences on that date. Returns up to `limit`
 * slots as {start, end} local ISO strings, earliest first. If `nearMin`
 * (minutes) is given, slots are sorted by distance to it instead.
 */
export function findFreeSlots(date, minutes, events, winStart = WORK_START, winEnd = WORK_END, limit = 5, nearMin = null) {
  const dayStart = toMin(`${date}T${String(winStart).padStart(2, '0')}:00`);
  const dayEnd = toMin(`${date}T${String(winEnd).padStart(2, '0')}:00`);
  const busy = mergeBusy(events.filter((e) => e.start.slice(0, 10) === date));
  const slots = [];
  let cursor = dayStart;
  const consider = (s, e) => {
    // offer several start times inside a big gap, stepped by 15 min
    for (let t = s; t + minutes <= e && slots.length < limit * 3; t += 15) {
      slots.push({ start: fromMin(t), end: fromMin(t + minutes) });
    }
  };
  for (const [bs, be] of busy) {
    if (bs > cursor) consider(cursor, Math.min(bs, dayEnd));
    cursor = Math.max(cursor, be);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) consider(cursor, dayEnd);
  if (nearMin != null) {
    slots.sort((a, b) => Math.abs(toMin(a.start) - nearMin) - Math.abs(toMin(b.start) - nearMin));
  }
  return slots.slice(0, limit);
}

// ---------- recurrence ----------

/**
 * Expand one stored event into occurrences within [from, to] (date strings).
 * Stored event: {id, title, start, end, rrule: null|'daily'|'weekly'|'weekdays',
 * rrule_until}. Occurrences carry occurrenceOf: id.
 */
export function expandRecurrence(ev, from, to) {
  if (!ev.rrule) {
    return ev.start.slice(0, 10) <= to && ev.start.slice(0, 10) >= from ? [{ ...ev, occurrenceOf: ev.id }] : [];
  }
  const out = [];
  const durMin = toMin(ev.end) - toMin(ev.start);
  const [sh, sm] = ev.start.slice(11, 16).split(':').map(Number);
  const until = ev.rrule_until || '2031-12-31';
  let d = ev.start.slice(0, 10);
  // start from the later of event start / range start
  if (d < from) {
    d = from;
  }
  let guard = 0;
  while (d <= to && d <= until && guard++ < 400) {
    const wd = parseDateStr(d).getDay();
    const ok =
      ev.rrule === 'daily' ||
      (ev.rrule === 'weekly' && d >= ev.start.slice(0, 10) && ((toMin(d + 'T00:00') - toMin(ev.start.slice(0, 10) + 'T00:00')) / 1440) % 7 === 0) ||
      (ev.rrule === 'weekdays' && wd >= 1 && wd <= 5);
    if (ok && d >= ev.start.slice(0, 10)) {
      const start = `${d}T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
      out.push({ ...ev, start, end: fromMin(toMin(start) + durMin), occurrenceOf: ev.id, date: d });
    }
    d = addDays(d, 1);
  }
  return out;
}

/** Expand a list of stored events. */
export function expandAll(events, from, to) {
  return events.flatMap((e) => expandRecurrence(e, from, to));
}

// ---------- formatting ----------

export function formatTime(iso) {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

export function formatDay(dateStr, now) {
  const today = fmtDate(now);
  if (dateStr === today) return 'today';
  if (dateStr === addDays(today, 1)) return 'tomorrow';
  const d = parseDateStr(dateStr);
  const name = DAY_NAMES[d.getDay()];
  const cap = name[0].toUpperCase() + name.slice(1);
  const diff = Math.round((d - parseDateStr(today)) / 86400000);
  if (diff >= 0 && diff < 7) return cap;
  return `${cap}, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** Match stored events by title words (upcoming first). */
export function matchEvents(titleQuery, events, now) {
  const words = titleQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const today = fmtDate(now);
  return events
    .filter((e) => {
      const tl = e.title.toLowerCase();
      return words.some((w) => tl.includes(w));
    })
    .sort((a, b) => {
      const aPast = a.start.slice(0, 10) < today ? 1 : 0;
      const bPast = b.start.slice(0, 10) < today ? 1 : 0;
      return aPast - bPast || (a.start < b.start ? -1 : 1);
    });
}

export const HELP_TEXT =
  `Try things like:\n` +
  `• "Lunch with Ana tomorrow at noon"\n` +
  `• "Dentist Friday 2pm"\n` +
  `• "Standup every weekday 9am"\n` +
  `• "Move dentist to Thursday"\n` +
  `• "Cancel lunch with Ana"\n` +
  `• "What's on Tuesday?"\n` +
  `• "Find 30 min free tomorrow afternoon"\n` +
  `• "train the model"\n` +
  `• "what patterns do you see"`;
