// src/external.js — external busy sources for Docket's scheduling agent.
// Server-side only: reads the iCal secret URL and GOA (GNOME Online Accounts)
// Google credentials, fetches Google Calendar events, and exposes normalized
// busy blocks {start,end,title,source,external:true} with a TTL cache.
// Secrets never leave this module. All failures are quiet and non-fatal.
//
// GOA pattern is adapted from outpost/src/goa.ts: busctl --user --json=short
// call org.gnome.OnlineAccounts ... The runner is injectable so tests never
// touch D-Bus. Google accounts use the same OAuth token GOA holds for mail
// (GetAccessToken after EnsureCredentials), then the Google Calendar v3 API.

import { existsSync } from 'node:fs';
import { parseIcs, expandIcal } from './ical.js';

export class ExternalError extends Error {
  kind;
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

/** @typedef {(cmd: string, args: string[], env?: Record<string,string>) => Promise<{code:number,stdout:string,stderr:string}>} RunFn */

const BUSCTL_TIMEOUT_MS = 15000;

export function busEnv() {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return {};
  const uid = process.getuid?.();
  const sock = uid !== undefined ? `/run/user/${uid}/bus` : '';
  try {
    if (sock && existsSync(sock)) return { DBUS_SESSION_BUS_ADDRESS: `unix:path=${sock}` };
  } catch { /* ignore */ }
  return {};
}

async function defaultRun(cmd, args, extraEnv) {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ...busEnv(), ...(extraEnv || {}) },
  });
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, BUSCTL_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- busctl --json parsing (same structural shape as outpost) ----------

function isBusVal(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.type === 'string' && 'data' in v && Object.keys(v).length === 2;
}

function busData(v) {
  if (isBusVal(v)) return busData(v.data);
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every((e) => Array.isArray(e) && e.length === 2 &&
        (typeof e[0] === 'string' || typeof e[0] === 'number'))) {
      const o = {};
      for (const [k, vv] of v) o[String(k)] = busData(vv);
      return o;
    }
    return v.map(busData);
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, vv] of Object.entries(v)) o[k] = busData(vv);
    return o;
  }
  return v;
}

const GOA_BUS = 'org.gnome.OnlineAccounts';
const GOA_ROOT = '/org/gnome/OnlineAccounts';

async function busCall(run, dest, path, iface, method, ...args) {
  let res;
  try {
    res = await run('busctl', ['--user', '--json=short', 'call', dest, path, iface, method, ...args]);
  } catch (e) {
    // busctl missing or spawn failed — same honest outcome as an unreachable daemon
    throw new ExternalError('unavailable', `GNOME Online Accounts not reachable: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout || '').trim().slice(0, 300);
    if (/ServiceUnknown|Failed to connect|Failed to set bus address|not provided by any|No such/i.test(err)) {
      throw new ExternalError('unavailable', `GNOME Online Accounts not reachable: ${err || 'busctl failed'}`);
    }
    throw new ExternalError('call-failed', `D-Bus call ${iface}.${method} failed: ${err || 'exit ' + res.code}`);
  }
  let parsed;
  try { parsed = JSON.parse(res.stdout); }
  catch { throw new ExternalError('call-failed', `could not parse busctl output for ${iface}.${method}`); }
  if (!isBusVal(parsed)) throw new ExternalError('call-failed', `unexpected busctl output shape for ${iface}.${method}`);
  const data = parsed.data;
  const outArgs = Array.isArray(data) ? data : [data];
  return outArgs.map(busData);
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function calendarEnabled(acc) {
  if ('CalendarDisabled' in acc) return acc['CalendarDisabled'] !== true;
  return acc['CalendarEnabled'] === true;
}

/**
 * All GOA accounts with calendar enabled (not just the first). Returns
 * [{ objectPath, id, providerType, providerName, identity }].
 */
export async function listGoaCalendarAccounts(run = defaultRun) {
  const [objs] = await busCall(run, GOA_BUS, GOA_ROOT, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects');
  const out = [];
  for (const [path, ifaces] of Object.entries(objs || {})) {
    try {
      const acc = ifaces['org.gnome.OnlineAccounts.Account'];
      if (!acc || !calendarEnabled(acc)) continue;
      out.push({
        objectPath: path,
        id: str(acc['Id']),
        providerType: str(acc['ProviderType']).toLowerCase(),
        providerName: str(acc['ProviderName']) || str(acc['ProviderType']),
        identity: str(acc['PresentationIdentity']),
      });
    } catch { /* skip malformed entries */ }
  }
  return out;
}

/** Ensure + fetch a fresh OAuth2 access token for one GOA account. */
export async function goaAccessToken(acct, run = defaultRun) {
  try {
    await busCall(run, GOA_BUS, acct.objectPath, 'org.gnome.OnlineAccounts.Account', 'EnsureCredentials');
  } catch (e) {
    throw new ExternalError('auth', `GOA account ${acct.identity}: re-authenticate in GNOME Settings`);
  }
  const [token] = await busCall(run, GOA_BUS, acct.objectPath, 'org.gnome.OnlineAccounts.OAuth2Based', 'GetAccessToken');
  if (typeof token !== 'string' || !token) throw new ExternalError('auth', `GOA account ${acct.identity}: no access token`);
  return token;
}

// ---------- Google Calendar API ----------

/**
 * Fetch events from Google's calendar API → busy blocks. `fetchFn` is
 * injectable for tests (defaults to global fetch). `accountId` tags blocks
 * so per-account counts can be reported by /api/sync.
 */
export async function fetchGoogleEvents(token, timeMin, timeMax, fetchFn = fetch, accountId = null) {
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' +
    new URLSearchParams({
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ExternalError('call-failed', `Google Calendar API ${res.status}`);
  const data = await res.json();
  const blocks = [];
  for (const item of data.items || []) {
    if (item.status === 'cancelled') continue;
    const s = item.start, e = item.end;
    if (!s || !e) continue;
    const toLocal = (v) => {
      const d = new Date(v.dateTime || v.date);
      if (isNaN(d)) return null;
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const start = toLocal(s), end = toLocal(e);
    if (!start || !end) continue;
    blocks.push({
      start, end, title: item.summary || 'Busy',
      source: 'Google calendar', external: true,
      uid: item.id || '', accountId,
    });
  }
  return blocks;
}

// ---------- iCal ----------

const ICAL_TIMEOUT_MS = 20000;

/** Fetch an iCal URL → parsed busy blocks in [from, to]. Never throws. */
export async function fetchIcalBlocks(url, from, to, fetchFn = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ICAL_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { Accept: 'text/calendar' } });
    if (!res.ok) throw new ExternalError('call-failed', `iCal fetch ${res.status}`);
    const text = await res.text();
    return expandIcal(parseIcs(text), from, to, 'iCal feed')
      .map((b) => ({ ...b, accountId: 'ical' }));
  } catch (e) {
    if (e instanceof ExternalError) throw e;
    throw new ExternalError('unavailable', `iCal fetch failed: ${String(e?.message || e).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- collector with TTL cache ----------

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, blocks: [], notes: [], accountStatus: [] };

/**
 * Collect external busy blocks for [from, to]. Settings: { icalUrl?: string,
 * goaEnabled?: boolean }. All sources are independent — one failing doesn't
 * kill the others. Never throws; returns { blocks, note, accountStatus }.
 */
export async function collectExternalBusy(settings, from, to, deps = {}) {
  const nowMs = Date.now();
  const fresh = nowMs - cache.at < CACHE_TTL_MS &&
    cache.fromKey === fmtKey(from) && cache.toKey === fmtKey(to);
  if (fresh) return { blocks: cache.blocks, note: cache.note, accountStatus: cache.accountStatus };

  const run = deps.run || defaultRun;
  const fetchFn = deps.fetch || fetch;
  const blocks = [];
  const notes = [];
  const accountStatus = [];

  const jobs = [];

  if (settings.icalUrl) {
    jobs.push((async () => {
      try {
        blocks.push(...await fetchIcalBlocks(settings.icalUrl, from, to, fetchFn));
      } catch (e) {
        notes.push('iCal feed unreachable');
      }
    })());
  }

  if (settings.goaEnabled !== false) {
    jobs.push((async () => {
      let accounts;
      try {
        accounts = await listGoaCalendarAccounts(run);
      } catch (e) {
        if (e instanceof ExternalError && e.kind === 'unavailable') {
          notes.push('GNOME accounts unreachable');
        }
        return;
      }
      for (const acct of accounts) {
        const st = { id: acct.id, identity: redactIdentity(acct.identity), provider: acct.providerName, status: 'ok' };
        accountStatus.push(st);
        if (acct.providerType !== 'google') {
          st.status = 'unsupported provider';
          continue;
        }
        try {
          const token = await goaAccessToken(acct, run);
          blocks.push(...await fetchGoogleEvents(token, from, to, fetchFn, acct.id));
          st.status = 'synced';
        } catch (e) {
          st.status = e instanceof ExternalError && e.kind === 'auth' ? 'needs re-auth' : 'error';
          notes.push(`Google calendar (${acct.providerName}) unavailable`);
        }
      }
    })());
  }

  await Promise.all(jobs);
  cache = {
    at: nowMs, blocks, note: notes.join('; ') || null,
    accountStatus, fromKey: fmtKey(from), toKey: fmtKey(to),
  };
  return { blocks, note: cache.note, accountStatus };
}

function fmtKey(d) { return d.toISOString(); }

export function redactIdentity(identity) {
  // "u...@gmail.com" — enough to recognize, never the full address in logs
  const at = identity.indexOf('@');
  if (at <= 1) return identity.slice(0, 1) + '…';
  return identity[0] + '…' + identity.slice(at);
}

/** Invalidate the TTL cache (called after settings change). */
export function invalidateCache() {
  cache.at = 0;
}

/**
 * Map an external busy block onto Docket's event shape for the calendar
 * views. The id is namespaced 'ext:' so mutations can reject it; clients
 * must treat these as read-only.
 */
export function toCalendarEvent(b) {
  const key = (b.uid && String(b.uid).trim()) || `${b.start}|${b.title}`;
  return {
    id: 'ext:' + key,
    occurrenceOf: null,
    title: b.title || 'Busy',
    start: b.start,
    end: b.end,
    location: '',
    notes: '',
    color: 'gray',
    rrule: null,
    external: true,
    source: b.source || 'external',
  };
}
