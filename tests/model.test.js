// tests/model.test.js — the local discriminative category model.
import { describe, test, expect } from 'bun:test';
import {
  mulberry32, tokenize, hourBucket, durationBucket, buildVocab,
  extractFeatures, train, predict, predictEvent, topWords,
  serialize, deserialize, summarizePatterns, N_TEMPORAL, MIN_LABELED,
  HOUR_BUCKET_NAMES,
} from '../src/model.js';

/** Cleanly separable synthetic calendar: work / health / social. */
function synth(seedN = 40) {
  const ex = [];
  const rng = mulberry32(7);
  const groups = [
    { color: 'blue', words: ['standup', 'sprint', 'review', 'planning', 'meeting'], hours: [9, 10, 14] },
    { color: 'green', words: ['gym', 'dentist', 'run', 'doctor', 'yoga'], hours: [7, 18, 19] },
    { color: 'orange', words: ['dinner', 'drinks', 'birthday', 'concert', 'brunch'], hours: [12, 19, 20] },
  ];
  // spread over a 30-day window starting 2026-09-20
  for (let i = 0; i < seedN; i++) {
    const g = groups[i % groups.length];
    const w = g.words[Math.floor(rng() * g.words.length)];
    const h = g.hours[Math.floor(rng() * g.hours.length)];
    const day = 20 + Math.floor(rng() * 28);
    const start = `2026-09-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`;
    const end = `2026-09-${String(day).padStart(2, '0')}T${String(h + 1).padStart(2, '0')}:00`;
    ex.push({ title: `Team ${w}`, start, end, color: g.color });
  }
  return ex;
}

describe('tokenize', () => {
  test('lowercases, strips punctuation, adds bigrams', () => {
    expect(tokenize('Lunch with Ana!')).toEqual(
      ['lunch', 'with', 'ana', 'lunch with', 'with ana']);
  });
  test('drops one-letter tokens', () => {
    expect(tokenize('a b c run')).toEqual(['run']);
  });
  test('empty title → no tokens', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('buckets', () => {
  test('hour buckets cover the day', () => {
    expect(hourBucket(3)).toBe(0);   // night
    expect(hourBucket(8)).toBe(1);   // morning
    expect(hourBucket(12)).toBe(2);  // midday
    expect(hourBucket(15)).toBe(3);  // afternoon
    expect(hourBucket(19)).toBe(4);  // evening
    expect(hourBucket(22)).toBe(5);  // late
    expect(HOUR_BUCKET_NAMES).toHaveLength(6);
  });
  test('duration buckets', () => {
    expect(durationBucket(15)).toBe(0);
    expect(durationBucket(45)).toBe(1);
    expect(durationBucket(90)).toBe(2);
    expect(durationBucket(180)).toBe(3);
  });
});

describe('extractFeatures', () => {
  test('one-hot temporal slots + vocab presence', () => {
    const vocab = ['standup', 'gym'];
    const f = extractFeatures({ title: 'Team standup', start: '2026-10-19T09:00', end: '2026-10-19T10:00' }, vocab);
    expect(f).toHaveLength(2 + N_TEMPORAL);
    expect(f[0]).toBe(1); // standup present
    expect(f[1]).toBe(0); // gym absent
    // 2026-10-19 is a Monday (dow 1)
    expect(f[2 + 1]).toBe(1);
    expect(f.slice(2, 9).reduce((a, b) => a + b, 0)).toBe(1);
    // 09:00 → morning bucket (1)
    expect(f[2 + 7 + 1]).toBe(1);
    // 60 min → bucket 2 (1–2h)
    expect(f[2 + 13 + 2]).toBe(1);
  });
});

describe('train', () => {
  test('refuses fewer than MIN_LABELED examples', () => {
    const few = synth(9);
    const r = train(few);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not enough labeled events');
    expect(r.n).toBe(9);
    expect(r.minN).toBe(MIN_LABELED);
  });
  test('refuses a single class', () => {
    const one = synth(12).map((e) => ({ ...e, color: 'blue' }));
    const r = train(one);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('need at least two categories');
  });
  test('separable data → high accuracy, sane CV', () => {
    const r = train(synth(60));
    expect(r.ok).toBe(true);
    expect(r.stats.trainAcc).toBeGreaterThan(0.95);
    expect(r.stats.cvAcc).toBeGreaterThan(0.8);
    expect(r.model.classes).toEqual(['blue', 'green', 'orange']);
    expect(r.stats.perClass.blue).toBeGreaterThan(10);
    expect(r.stats.smallSample).toBe(false);
  });
  test('deterministic: same data → identical weights', () => {
    const a = train(synth(40));
    const b = train(synth(40));
    expect(serialize(a.model)).toBe(serialize(b.model));
  });
  test('predicts the right class with high confidence', () => {
    const r = train(synth(60));
    const p = predictEvent({ title: 'Sprint planning review', start: '2026-10-21T10:00', end: '2026-10-21T11:00' }, r.model);
    expect(p[0].class).toBe('blue');
    expect(p[0].prob).toBeGreaterThan(0.6);
    expect(p.map((x) => x.prob).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const q = predictEvent({ title: 'Dentist appointment', start: '2026-10-21T18:30', end: '2026-10-21T19:00' }, r.model);
    expect(q[0].class).toBe('green');
  });
  test('serialization round-trip preserves predictions', () => {
    const r = train(synth(40));
    const m2 = deserialize(serialize(r.model));
    const ev = { title: 'Birthday drinks', start: '2026-10-23T20:00', end: '2026-10-23T22:00' };
    expect(predictEvent(ev, m2)).toEqual(predictEvent(ev, r.model));
  });
  test('deserialize rejects garbage', () => {
    expect(() => deserialize('{"v":2}')).toThrow();
    expect(() => deserialize('nope')).toThrow();
  });
  test('topWords surfaces class evidence words', () => {
    const r = train(synth(60));
    const blue = topWords(r.model, 'blue', 10).map((t) => t.word);
    expect(blue.some((w) => ['standup', 'sprint', 'review', 'planning', 'meeting'].includes(w))).toBe(true);
    const green = topWords(r.model, 'green', 10).map((t) => t.word);
    expect(green.some((w) => ['gym', 'dentist', 'run', 'doctor', 'yoga'].includes(w))).toBe(true);
    expect(topWords(r.model, 'nope')).toEqual([]);
  });
  test('bigrams are learned too (vocab includes them)', () => {
    const ex = [];
    for (let i = 0; i < 15; i++) {
      ex.push({ title: 'one on one', start: `2026-09-${String(20 + i).padStart(2, '0')}T10:00`, end: `2026-09-${String(20 + i).padStart(2, '0')}T11:00`, color: 'blue' });
      ex.push({ title: 'team lunch', start: `2026-09-${String(20 + i).padStart(2, '0')}T12:00`, end: `2026-09-${String(20 + i).padStart(2, '0')}T13:00`, color: 'orange' });
    }
    const r = train(ex);
    expect(r.ok).toBe(true);
    expect(r.model.vocab).toContain('one on');
    const p = predictEvent({ title: 'one on one with sam', start: '2026-10-21T10:00', end: '2026-10-21T11:00' }, r.model);
    expect(p[0].class).toBe('blue');
  });
});

describe('summarizePatterns', () => {
  test('distribution + habits from labeled examples', () => {
    const ex = [];
    // Friday afternoons are orange (2026-10-23 is a Friday)
    for (let i = 0; i < 4; i++) {
      const d = String(2 + i * 7).padStart(2, '0');
      ex.push({ title: 'drinks night', start: `2026-10-${d}T19:00`, end: `2026-10-${d}T21:00`, color: 'orange' });
    }
    for (let i = 0; i < 6; i++) {
      const d = String(5 + i).padStart(2, '0');
      ex.push({ title: 'standup', start: `2026-10-${d}T09:00`, end: `2026-10-${d}T09:30`, color: 'blue' });
    }
    const s = summarizePatterns(ex, null);
    expect(s.n).toBe(10);
    expect(s.dist).toEqual({ orange: 4, blue: 6 });
    expect(s.topWordsByClass).toEqual({});
    expect(s.habits.some((h) => h.when.includes('Friday') && h.cls === 'orange')).toBe(true);
  });
  test('top words per class when a model is given', () => {
    const r = train(synth(45));
    const s = summarizePatterns(synth(45), r.model);
    expect(Object.keys(s.topWordsByClass)).toEqual(['blue', 'green', 'orange']);
    expect(s.topWordsByClass.blue.length).toBeGreaterThan(0);
  });
});

describe('buildVocab', () => {
  test('most frequent first, capped', () => {
    const ex = [
      { title: 'standup standup standup', color: 'blue' },
      { title: 'standup review', color: 'blue' },
      { title: 'gym', color: 'green' },
    ];
    const v = buildVocab(ex, 2);
    expect(v[0]).toBe('standup');
    expect(v).toHaveLength(2);
  });
});
