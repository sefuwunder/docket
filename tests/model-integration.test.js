// tests/model-integration.test.js — real HTTP against a spawned server.
// Seeds 30 days of explicitly-tagged synthetic events, trains the category
// model, and exercises the agent's tag-suggestion flow end to end.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';

const DIR = '/home/hatch/workspace/your_files/docket';
const PORT = 43772;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const p2 = (n) => String(n).padStart(2, '0');

beforeAll(async () => {
  rmSync(`${DIR}/data`, { recursive: true, force: true });
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
});

const SEED = [
  { words: ['Team standup', 'Sprint planning', 'Sprint review', 'Planning meeting'], color: 'blue', hours: [9, 10, 14, 15] },
  { words: ['Gym session', 'Morning run', 'Dentist', 'Yoga class'], color: 'green', hours: [18, 7, 14, 19] },
  { words: ['Dinner with friends', 'Team lunch', 'Birthday party', 'Drinks night'], color: 'orange', hours: [19, 12, 20, 18] },
];

/** Deterministic PRNG so the seed is stable across runs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seed30() {
  // one event per day for 30 days (2026-09-20 .. 2026-10-19), rotating classes,
  // random word + hour per event so the model must generalize, not memorize
  const rng = mulberry32(99);
  for (let i = 0; i < 30; i++) {
    const g = SEED[i % 3];
    const day = 20 + i;
    const d = day <= 30 ? `2026-09-${p2(day)}` : `2026-10-${p2(day - 30)}`;
    const h = g.hours[Math.floor(rng() * g.hours.length)];
    const w = g.words[Math.floor(rng() * g.words.length)];
    const r = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title: w,
        start: `${d}T${p2(h)}:00`,
        end: `${d}T${p2(h + 1)}:00`,
        color: g.color, // explicit → color_set=1
      }),
    });
    expect(r.status).toBe(201);
  }
}

describe('POST /api/model/train', () => {
  test('trains on 30 days of tagged events with sane accuracy', async () => {
    await seed30();
    const r = await api('/api/model/train', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.trained).toBe(true);
    expect(r.body.n).toBe(30);
    expect(r.body.classes.sort()).toEqual(['blue', 'green', 'orange']);
    expect(r.body.cvAcc).toBeGreaterThan(0.7);
    expect(r.body.perClass).toEqual({ blue: 10, green: 10, orange: 10 });
    expect(r.body.trainedAt).toBeTruthy();
  });

  test('GET /api/model/status reflects the trained model', async () => {
    const r = await api('/api/model/status');
    expect(r.body.trained).toBe(true);
    expect(r.body.n).toBe(30);
    expect(r.body.classes).toHaveLength(3);
  });
});

describe('agent tag suggestion', () => {
  test('create offers a predicted tag chip (never auto-applied)', async () => {
    // "tomorrow" = 2026-10-20, which has no seeded events → no conflict
    const r = await api('/api/agent', {
      method: 'POST',
      body: JSON.stringify({ message: 'gym session tomorrow at 6pm' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.reply).toContain('Done');
    const chip = (r.body.chips || []).find((c) => c.action && c.action.type === 'applytag');
    expect(chip).toBeTruthy();
    expect(chip.action.color).toBe('green');
    expect(chip.label).toMatch(/Tag green \(\d+%\)/);

    // the event itself is still untagged (default blue, not auto-applied)
    const evs = await api('/api/events?from=2026-10-20&to=2026-10-20');
    const created = evs.body.find((e) => e.title === 'gym session');
    expect(created).toBeTruthy();
    expect(created.color).toBe('blue');

    // tapping the chip applies the tag explicitly
    const t = await api('/api/agent', {
      method: 'POST',
      body: JSON.stringify({ applytag: chip.action }),
    });
    expect(t.body.reply).toBe("Tagged 'gym session' green.");
    expect(t.body.refresh).toBe(true);
    const evs2 = await api('/api/events?from=2026-10-20&to=2026-10-20');
    expect(evs2.body.find((e) => e.title === 'gym session').color).toBe('green');
  });

  test('"train the model" intent works from chat', async () => {
    const r = await api('/api/agent', {
      method: 'POST',
      body: JSON.stringify({ message: 'train the model' }),
    });
    expect(r.body.reply).toContain('Model trained');
    expect(r.body.reply).toContain('tagged events');
  });

  test('"what patterns do you see" summarizes the last 30 days', async () => {
    const r = await api('/api/agent', {
      method: 'POST',
      body: JSON.stringify({ message: 'what patterns do you see' }),
    });
    expect(r.body.reply).toContain('Last 30 days');
    expect(r.body.reply).toContain('blue');
    expect(r.body.reply).toContain('smells like');
  });
});

describe('GET /api/model/predict', () => {
  test('advisory suggestions for the event sheet', async () => {
    const r = await api('/api/model/predict?title=' + encodeURIComponent('Sprint review') +
      '&start=2026-10-21T15:00&end=2026-10-21T16:00');
    expect(r.body.suggestions[0].class).toBe('blue');
    expect(r.body.suggestions[0].prob).toBeGreaterThan(0.5);
  });
  test('empty without title or model', async () => {
    const r = await api('/api/model/predict?title=&start=2026-10-21T15:00&end=2026-10-21T16:00');
    expect(r.body.suggestions).toEqual([]);
  });
});

describe('honest refusal', () => {
  test('fewer than 10 labeled events → no junk model', async () => {
    const evs = await api('/api/events?from=2026-09-01&to=2026-10-31');
    for (const e of evs.body) {
      if (typeof e.id === 'number') await api(`/api/events/${e.id}`, { method: 'DELETE' });
    }
    const r = await api('/api/model/train', { method: 'POST' });
    expect(r.body.trained).toBe(false);
    expect(r.body.reason).toBe('not enough labeled events');
    expect(r.body.hint).toContain('Tag at least 10 events');
    // status still reports the OLD model (training is additive, never destructive)
    const s = await api('/api/model/status');
    expect(s.body.trained).toBe(true);
  });
});
