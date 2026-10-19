// tests/external.test.js — bun test for src/external.js
// GOA and HTTP are fully mocked: nothing here touches the real keyring,
// D-Bus, or the network.
import { describe, test, expect } from 'bun:test';
import {
  listGoaCalendarAccounts, goaAccessToken, fetchGoogleEvents, fetchIcalBlocks,
  collectExternalBusy, invalidateCache, redactIdentity, busEnv,
} from '../src/external.js';

// busctl --json=short shape: {"type": sig, "data": [managed-objects-dict]}
function busReply(objs) {
  const wrap = (v) => {
    if (Array.isArray(v)) return { type: 'a', data: v.map(wrap) };
    if (v && typeof v === 'object') {
      const data = Object.entries(v).map(([k, vv]) => [k, wrap(vv)]);
      return { type: 'a{sv}', data };
    }
    return { type: 's', data: v };
  };
  const data = Object.entries(objs).map(([path, ifaces]) => [path, wrap(ifaces)]);
  return { type: '(a{oa{sa{sv}}})', data: [data] };
}

function fakeRun(handlers) {
  return async (cmd, args) => {
    const key = args.join(' ');
    for (const [match, fn] of handlers) {
      if (key.includes(match)) return fn(cmd, args);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

const CAL_PATH = '/org/gnome/OnlineAccounts/Accounts/1';
function goaObjs(extra = {}) {
  return busReply({
    [CAL_PATH]: {
      'org.gnome.OnlineAccounts.Account': {
        Id: 'goa_account_1', ProviderType: 'google', ProviderName: 'Google',
        PresentationIdentity: 'user@example.com', CalendarEnabled: true,
      },
      'org.gnome.OnlineAccounts.OAuth2Based': {},
    },
    '/org/gnome/OnlineAccounts/Accounts/2': {
      'org.gnome.OnlineAccounts.Account': {
        Id: 'goa_account_2', ProviderType: 'nextcloud', ProviderName: 'Nextcloud',
        PresentationIdentity: 'user@cloud.example', CalendarEnabled: true,
      },
      'org.gnome.OnlineAccounts.OAuth2Based': {},
    },
    '/org/gnome/OnlineAccounts/Accounts/3': {
      'org.gnome.OnlineAccounts.Account': {
        Id: 'goa_account_3', ProviderType: 'google', ProviderName: 'Google',
        PresentationIdentity: 'mail@example.com', CalendarDisabled: true,
      },
      'org.gnome.OnlineAccounts.OAuth2Based': {},
    },
    ...extra,
  });
}

describe('GOA enumeration', () => {
  test('lists all calendar-enabled accounts, skips CalendarDisabled', async () => {
    const run = fakeRun([
      ['GetManagedObjects', async () => ({ code: 0, stdout: JSON.stringify(goaObjs()), stderr: '' })],
    ]);
    const accounts = await listGoaCalendarAccounts(run);
    expect(accounts.map((a) => a.id).sort()).toEqual(['goa_account_1', 'goa_account_2']);
    expect(accounts[0].providerType).toBe('google');
    expect(accounts[0].identity).toBe('user@example.com');
  });

  test('unavailable GOA → ExternalError(unavailable)', async () => {
    const run = async () => ({ code: 1, stdout: '', stderr: 'ServiceUnknown' });
    try {
      await listGoaCalendarAccounts(run);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.kind).toBe('unavailable');
    }
  });

  test('GetAccessToken after EnsureCredentials', async () => {
    const calls = [];
    const run = fakeRun([
      ['EnsureCredentials', async () => { calls.push('ensure'); return { code: 0, stdout: '{"type":"()","data":[]}', stderr: '' }; }],
      ['GetAccessToken', async () => { calls.push('token'); return { type: 's', data: 'tok123' } && { code: 0, stdout: '{"type":"(s)","data":["tok123"]}', stderr: '' }; }],
    ]);
    const token = await goaAccessToken({ objectPath: CAL_PATH, identity: 'u@x' }, run);
    expect(token).toBe('tok123');
    expect(calls).toEqual(['ensure', 'token']); // ensure runs first
  });
});

describe('Google Calendar API', () => {
  test('maps items to busy blocks, skips cancelled', async () => {
    const fetchFn = async (url, opts) => {
      expect(opts.headers.Authorization).toBe('Bearer tok');
      expect(url).toContain('timeMin=');
      expect(url).toContain('singleEvents=true');
      return {
        ok: true,
        json: async () => ({
          items: [
            { status: 'confirmed', summary: 'Team sync', start: { dateTime: '2026-10-20T14:00:00Z' }, end: { dateTime: '2026-10-20T15:00:00Z' } },
            { status: 'cancelled', summary: 'Old', start: { dateTime: '2026-10-20T16:00:00Z' }, end: { dateTime: '2026-10-20T17:00:00Z' } },
            { status: 'confirmed', summary: 'Offsite', start: { date: '2026-10-21' }, end: { date: '2026-10-22' } },
          ],
        }),
      };
    };
    const blocks = await fetchGoogleEvents('tok', new Date('2026-10-19T00:00:00Z'), new Date('2026-10-23T00:00:00Z'), fetchFn);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].title).toBe('Team sync');
    expect(blocks[0].source).toBe('Google calendar');
    expect(blocks[0].external).toBe(true);
    expect(blocks[1].title).toBe('Offsite');
  });

  test('API error → ExternalError', async () => {
    const fetchFn = async () => ({ ok: false, status: 401 });
    try {
      await fetchGoogleEvents('bad', new Date(), new Date(), fetchFn);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.kind).toBe('call-failed');
    }
  });
});

describe('iCal fetch', () => {
  test('parses fetched ICS', async () => {
    const fetchFn = async () => ({
      ok: true,
      text: async () => `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
SUMMARY:Ext lunch
DTSTART:20261020T120000
DTEND:20261020T130000
END:VEVENT
END:VCALENDAR`,
    });
    const blocks = await fetchIcalBlocks('https://x/y.ics', new Date(2026, 9, 19), new Date(2026, 9, 22), fetchFn);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('Ext lunch');
    expect(blocks[0].source).toBe('iCal feed');
    expect(blocks[0].external).toBe(true);
  });

  test('HTTP error → ExternalError', async () => {
    const fetchFn = async () => ({ ok: false, status: 404 });
    try {
      await fetchIcalBlocks('https://x/y.ics', new Date(), new Date(), fetchFn);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.kind).toBe('call-failed');
    }
  });
});

describe('collectExternalBusy', () => {
  const from = new Date(2026, 9, 19, 0, 0);
  const to = new Date(2026, 9, 22, 0, 0);

  test('combines iCal + Google, never throws on per-source failure', async () => {
    invalidateCache();
    let googleCalls = 0;
    const run = fakeRun([
      ['GetManagedObjects', async () => ({ code: 0, stdout: JSON.stringify(goaObjs()), stderr: '' })],
      ['EnsureCredentials', async () => ({ code: 0, stdout: '{"type":"()","data":[]}', stderr: '' })],
      ['GetAccessToken', async () => { googleCalls++; return { code: 0, stdout: '{"type":"(s)","data":["tok"]}', stderr: '' }; }],
    ]);
    const fetchFn = async (url) => {
      if (String(url).startsWith('https://www.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ status: 'confirmed', summary: 'G meet', start: { dateTime: '2026-10-20T14:00:00Z' }, end: { dateTime: '2026-10-20T15:00:00Z' } }],
          }),
        };
      }
      return {
        ok: true,
        text: async () => `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:b
SUMMARY:iCal thing
DTSTART:20261020T090000
DTEND:20261020T100000
END:VEVENT
END:VCALENDAR`,
      };
    };
    const r = await collectExternalBusy({ icalUrl: 'https://x/y.ics', goaEnabled: true }, from, to, { run, fetch: fetchFn });
    expect(googleCalls).toBe(1); // only the google account syncs; nextcloud skipped
    expect(r.accountStatus.find((s) => s.id === 'goa_account_2').status).toBe('unsupported provider');
    expect(r.accountStatus.find((s) => s.id === 'goa_account_1').status).toBe('synced');
    const titles = r.blocks.map((b) => b.title).sort();
    expect(titles).toEqual(['G meet', 'iCal thing']);
    expect(r.blocks.every((b) => b.external)).toBe(true);
  });

  test('iCal down → quiet fallback with note, Google still works', async () => {
    invalidateCache();
    const run = fakeRun([
      ['GetManagedObjects', async () => ({ code: 0, stdout: JSON.stringify(goaObjs()), stderr: '' })],
      ['EnsureCredentials', async () => ({ code: 0, stdout: '{"type":"()","data":[]}', stderr: '' })],
      ['GetAccessToken', async () => ({ code: 0, stdout: '{"type":"(s)","data":["tok"]}', stderr: '' })],
    ]);
    const fetchFn = async (url) => {
      if (String(url).startsWith('https://www.googleapis.com')) {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      throw new Error('network down');
    };
    const r = await collectExternalBusy({ icalUrl: 'https://x/y.ics', goaEnabled: true }, from, to, { run, fetch: fetchFn });
    expect(r.note).toContain('iCal');
    expect(r.blocks).toEqual([]);
  });

  test('GOA disabled → no GOA calls', async () => {
    invalidateCache();
    let busCalls = 0;
    const run = async () => { busCalls++; return { code: 0, stdout: '{}', stderr: '' }; };
    const r = await collectExternalBusy({ icalUrl: undefined, goaEnabled: false }, from, to, { run });
    expect(busCalls).toBe(0);
    expect(r.blocks).toEqual([]);
    expect(r.note).toBeNull();
  });

  test('cache: second call within TTL reuses', async () => {
    invalidateCache();
    let icalCalls = 0;
    const fetchFn = async () => {
      icalCalls++;
      return { ok: true, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' };
    };
    const run = async () => ({ code: 1, stdout: '', stderr: 'ServiceUnknown' });
    await collectExternalBusy({ icalUrl: 'https://x/y.ics', goaEnabled: false }, from, to, { run, fetch: fetchFn });
    await collectExternalBusy({ icalUrl: 'https://x/y.ics', goaEnabled: false }, from, to, { run, fetch: fetchFn });
    expect(icalCalls).toBe(1);
  });
});

describe('identity redaction', () => {
  test('redactIdentity hides the local part', () => {
    expect(redactIdentity('user@example.com')).toBe('u…@example.com');
  });
});

describe('busEnv', () => {
  test('returns an object', () => {
    expect(typeof busEnv()).toBe('object');
  });
});
