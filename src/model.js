// src/model.js — Docket's local category model.
//
// Judgment call (stated in README): the discriminative target is the event's
// COLOR TAG — the only labels in the system. The model learns P(color | title
// words + temporal features) so the agent can suggest a tag for new events
// ("looks like a work meeting — tagging blue") and report learned patterns.
// Pure ESM, no deps: importable by `bun test`, the Bun server, and the
// browser. Multinomial logistic regression (softmax) trained with full-batch
// gradient descent + L2. Fully deterministic: seeded init, fixed epochs, fixed
// learning-rate schedule — same data always yields identical weights.
//
// Tiny-data honesty: 30 days of a personal calendar is tens of events, so L2
// regularization (default lambda=0.1) keeps weights in check, and train()
// refuses to build a model from fewer than MIN_N labeled examples.

export const MIN_LABELED = 10;

// ---------- seeded PRNG (mulberry32) ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- feature extraction ----------

/** Lowercased tokens (len >= 2) + bigrams. */
export function tokenize(title) {
  const toks = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length >= 2);
  const out = [...toks];
  for (let i = 0; i + 1 < toks.length; i++) out.push(toks[i] + ' ' + toks[i + 1]);
  return out;
}

/** Start-hour → one of 6 buckets: night/morning/midday/afternoon/evening/late. */
export function hourBucket(h) {
  if (h < 6) return 0;   // night   00–05
  if (h < 11) return 1;  // morning 06–10
  if (h < 14) return 2;  // midday  11–13
  if (h < 17) return 3;  // afternoon 14–16
  if (h < 21) return 4;  // evening 17–20
  return 5;              // late    21–23
}

export const HOUR_BUCKET_NAMES = ['night', 'morning', 'midday', 'afternoon', 'evening', 'late'];

/** Duration minutes → one of 4 buckets. */
export function durationBucket(mins) {
  if (mins < 30) return 0;
  if (mins < 60) return 1;
  if (mins < 120) return 2;
  return 3;
}

export const DURATION_BUCKET_NAMES = ['<30m', '30–60m', '1–2h', '>2h'];

export const N_TEMPORAL = 7 + 6 + 4; // dow one-hot + hour buckets + duration buckets

/** Build a vocab of the most frequent tokens (unigrams + bigrams), capped. */
export function buildVocab(examples, cap = 600) {
  const freq = new Map();
  for (const e of examples) {
    for (const t of new Set(tokenize(e.title))) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, cap)
    .map(([t]) => t);
}

function durationMin(start, end) {
  // 'YYYY-MM-DDTHH:MM' local; direct subtraction is timezone-safe for durations
  const p = (s) => {
    const [d, tm] = s.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = tm.split(':').map(Number);
    return new Date(y, mo - 1, da, h, mi).getTime();
  };
  return Math.max(1, Math.round((p(end) - p(start)) / 60000));
}

/**
 * Feature vector: [vocab presence bits..., dow one-hot (7), hour bucket (6),
 * duration bucket (4)]. ev = {title, start, end}.
 */
export function extractFeatures(ev, vocab) {
  const feats = new Array(vocab.length + N_TEMPORAL).fill(0);
  const present = new Set(tokenize(ev.title));
  for (let i = 0; i < vocab.length; i++) if (present.has(vocab[i])) feats[i] = 1;
  const dow = new Date(ev.start.slice(0, 10) + 'T12:00').getDay();
  feats[vocab.length + dow] = 1;
  feats[vocab.length + 7 + hourBucket(Number(ev.start.slice(11, 13)))] = 1;
  feats[vocab.length + 13 + durationBucket(durationMin(ev.start, ev.end))] = 1;
  return feats;
}

// ---------- training ----------

function softmax(scores) {
  const m = Math.max(...scores);
  const ex = scores.map((s) => Math.exp(s - m));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function accuracyOf(X, y, W, b) {
  let hit = 0;
  for (let i = 0; i < X.length; i++) {
    const probs = softmax(W.map((w, c) => dot(w, X[i]) + b[c]));
    let best = 0;
    for (let c = 1; c < probs.length; c++) if (probs[c] > probs[best]) best = c;
    if (best === y[i]) hit++;
  }
  return hit / X.length;
}

/** Deterministic stratified round-robin fold assignment. */
function folds(y, k) {
  const byClass = new Map();
  y.forEach((c, i) => {
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(i);
  });
  const assign = new Array(y.length).fill(0);
  for (const idxs of byClass.values()) {
    idxs.forEach((gi, j) => { assign[gi] = j % k; });
  }
  return assign;
}

function fitLogReg(X, y, C, D, { seed = 42, lr = 0.5, lambda = 2.0, epochs = 300 } = {}) {
  const rng = mulberry32(seed);
  const W = Array.from({ length: C }, () =>
    Array.from({ length: D }, () => (rng() - 0.5) * 0.02));
  const b = new Array(C).fill(0);
  const n = X.length;
  const grad = Array.from({ length: C }, () => new Array(D).fill(0));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const rate = lr / (1 + epoch / 100);
    for (let c = 0; c < C; c++) grad[c].fill(0);
    const gb = new Array(C).fill(0);
    for (let i = 0; i < n; i++) {
      const scores = W.map((w, c) => dot(w, X[i]) + b[c]);
      const p = softmax(scores);
      for (let c = 0; c < C; c++) {
        const err = p[c] - (y[i] === c ? 1 : 0);
        gb[c] += err / n;
        const g = grad[c], xi = X[i];
        for (let j = 0; j < D; j++) g[j] += (err * xi[j]) / n;
      }
    }
    for (let c = 0; c < C; c++) {
      b[c] -= rate * gb[c]; // bias unregularized
      const w = W[c], g = grad[c];
      for (let j = 0; j < D; j++) w[j] -= rate * (g[j] + lambda * w[j]);
    }
  }
  return { W, b };
}

/**
 * Train on labeled examples [{title, start, end, color}].
 * Returns {ok:false, reason, n, minN} when there isn't enough to learn from,
 * else {ok:true, model, stats}. The feature/label plumbing is deliberately
 * generic: swap `e.color` for another target (e.g. duration bucket) and the
 * rest works unchanged.
 */
export function train(examples, opts = {}) {
  const minN = opts.minN ?? MIN_LABELED;
  const labeled = examples.filter((e) => e && e.color);
  if (labeled.length < minN) {
    return { ok: false, reason: 'not enough labeled events', n: labeled.length, minN };
  }
  const classes = [...new Set(labeled.map((e) => e.color))].sort();
  if (classes.length < 2) {
    return { ok: false, reason: 'need at least two categories', n: labeled.length, classes };
  }
  const ci = new Map(classes.map((c, i) => [c, i]));
  const vocab = buildVocab(labeled, opts.vocabCap ?? 600);
  const X = labeled.map((e) => extractFeatures(e, vocab));
  const y = labeled.map((e) => ci.get(e.color));
  const D = X[0].length, C = classes.length;
  const fitOpts = { seed: opts.seed ?? 42, lr: opts.lr ?? 0.5, lambda: opts.lambda ?? 0.1, epochs: opts.epochs ?? 500 };
  const { W, b } = fitLogReg(X, y, C, D, fitOpts);
  const trainAcc = accuracyOf(X, y, W, b);

  // k-fold CV (deterministic); needs ≥2 samples per class to stratify
  let cvAcc = null;
  const minClass = Math.min(...classes.map((c) => y.filter((v) => v === ci.get(c)).length));
  const k = Math.min(5, minClass);
  if (k >= 2) {
    const assign = folds(y, k);
    let sum = 0;
    for (let f = 0; f < k; f++) {
      const trX = [], trY = [], teX = [], teY = [];
      X.forEach((x, i) => ((assign[i] === f ? teX : trX).push(x), (assign[i] === f ? teY : trY).push(y[i])));
      const m = fitLogReg(trX, trY, C, D, fitOpts);
      sum += accuracyOf(teX, teY, m.W, m.b);
    }
    cvAcc = sum / k;
  }

  const perClass = {};
  for (const c of classes) perClass[c] = y.filter((v) => v === ci.get(c)).length;

  const model = { v: 1, classes, vocab, W, b, meta: { ...fitOpts, featureDim: D } };
  return {
    ok: true,
    model,
    stats: { n: labeled.length, classes, trainAcc, cvAcc, perClass, smallSample: labeled.length < 25 },
  };
}

/** Predict: [{class, prob}] sorted by probability desc. */
export function predict(feats, model) {
  const scores = model.classes.map((c, i) => dot(model.W[i], feats) + model.b[i]);
  const probs = softmax(scores);
  return model.classes
    .map((c, i) => ({ class: c, prob: probs[i] }))
    .sort((a, b) => b.prob - a.prob);
}

export function predictEvent(ev, model) {
  return predict(extractFeatures(ev, model.vocab), model);
}

// ---------- inspection ----------

/** Top-k weighted vocab words for a class (positive weights = evidence for it). */
export function topWords(model, cls, k = 8) {
  const i = model.classes.indexOf(cls);
  if (i < 0) return [];
  return model.vocab
    .map((w, j) => ({ word: w, weight: model.W[i][j] }))
    .filter((t) => !t.word.includes(' '))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, k);
}

// ---------- serialization ----------

export function serialize(model) {
  return JSON.stringify(model);
}

export function deserialize(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : json;
  if (!m || m.v !== 1 || !Array.isArray(m.classes) || !Array.isArray(m.vocab) ||
      !Array.isArray(m.W) || !Array.isArray(m.b)) {
    throw new Error('not a category model');
  }
  return m;
}

// ---------- pattern summary (pure; server formats the reply) ----------

/**
 * From labeled examples + trained model: class distribution, top words per
 * class, and habitual (day-of-week × hour-bucket) cells that are strongly
 * one class. Returns a plain structure; formatting is the caller's job.
 */
export function summarizePatterns(examples, model) {
  const labeled = examples.filter((e) => e && e.color);
  const dist = {};
  for (const e of labeled) dist[e.color] = (dist[e.color] || 0) + 1;

  const topWordsByClass = {};
  if (model) {
    for (const c of model.classes) topWordsByClass[c] = topWords(model, c, 6).map((t) => t.word);
  }

  // habitual cells: (dow, hourBucket) with >=3 events and >=75% one class
  const cells = new Map();
  for (const e of labeled) {
    const key = new Date(e.start.slice(0, 10) + 'T12:00').getDay() + '|' +
      hourBucket(Number(e.start.slice(11, 13)));
    if (!cells.has(key)) cells.set(key, { dow: Number(key.split('|')[0]), hb: Number(key.split('|')[1]), counts: {} });
    const cell = cells.get(key);
    cell.counts[e.color] = (cell.counts[e.color] || 0) + 1;
  }
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const habits = [];
  for (const cell of cells.values()) {
    const total = Object.values(cell.counts).reduce((a, x) => a + x, 0);
    const [cls, n] = Object.entries(cell.counts).sort((a, b) => b[1] - a[1])[0];
    if (total >= 3 && n / total >= 0.75) {
      habits.push({ when: `${DOW[cell.dow]} ${HOUR_BUCKET_NAMES[cell.hb]}s`, cls, n, total });
    }
  }
  habits.sort((a, b) => b.n - a.n);
  return { n: labeled.length, dist, topWordsByClass, habits: habits.slice(0, 5) };
}
