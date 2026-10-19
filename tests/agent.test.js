// tests/agent.test.js — bun test for src/agent.js
import { describe, test, expect } from 'bun:test';
import {
  fmtDate, addDays, upcomingWeekday, thisWeekday, nextWeekday,
  extractDate, extractTime, extractDuration, extractRecurrence,
  extractPartOfDay, cleanTitle, parseMessage,
  toMin, fromMin, overlaps, detectConflicts, findFreeSlots,
  expandRecurrence, expandAll, formatTime, formatDay, matchEvents,
} from '../src/agent.js';

// Monday 2026-10-19 10:00 local — pin "now" for every test
const NOW = new Date(2026, 9, 19, 10, 0);

describe('date helpers', () => {
  test('fmtDate / addDays', () => {
    expect(fmtDate(NOW)).toBe('2026-10-19');
    expect(addDays('2026-10-19', 1)).toBe('2026-10-20');
    expect(addDays('2026-10-19', -1)).toBe('2026-10-18');
  });
  test('upcomingWeekday: bare Friday -> Oct 23', () => {
    expect(upcomingWeekday(NOW, 5)).toBe('2026-10-23');
  });
  test('upcomingWeekday: today (Monday) -> today', () => {
    expect(upcomingWeekday(NOW, 1)).toBe('2026-10-19');
  });
  test('this Friday -> Oct 23 (same week, not past)', () => {
    expect(thisWeekday(NOW, 5)).toBe('2026-10-23');
  });
  test('next Friday -> Oct 30', () => {
    expect(nextWeekday(NOW, 5)).toBe('2026-10-30');
  });
});

describe('extractDate', () => {
  test('today/tomorrow/day after tomorrow', () => {
    expect(extractDate('do it today', NOW).date).toBe('2026-10-19');
    expect(extractDate('do it tomorrow', NOW).date).toBe('2026-10-20');
    expect(extractDate('day after tomorrow', NOW).date).toBe('2026-10-21');
  });
  test('bare weekday -> nearest upcoming', () => {
    expect(extractDate('dentist friday', NOW).date).toBe('2026-10-23');
    expect(extractDate('see you tuesday', NOW).date).toBe('2026-10-20');
  });
  test('this Friday vs next Friday', () => {
    expect(extractDate('this friday', NOW).date).toBe('2026-10-23');
    expect(extractDate('next friday', NOW).date).toBe('2026-10-30');
  });
  test('month day forms', () => {
    expect(extractDate('on October 23', NOW).date).toBe('2026-10-23');
    expect(extractDate('oct 23', NOW).date).toBe('2026-10-23');
    expect(extractDate('the 23rd of October', NOW).date).toBe('2026-10-23');
    expect(extractDate('2026-10-23', NOW).date).toBe('2026-10-23');
  });
  test('past month-day rolls to next year', () => {
    expect(extractDate('january 5', NOW).date).toBe('2027-01-05');
  });
  test('no date -> null', () => {
    expect(extractDate('just some words', NOW)).toBeNull();
  });
});

describe('extractTime', () => {
  test('noon/midnight', () => {
    expect(extractTime('at noon').hour).toBe(12);
    expect(extractTime('at midnight').hour).toBe(0);
  });
  test('am/pm forms', () => {
    const t = extractTime('2pm');
    expect([t.hour, t.minute]).toEqual([14, 0]);
    const t2 = extractTime('2:30 pm');
    expect([t2.hour, t2.minute]).toEqual([14, 30]);
    const t3 = extractTime('9am');
    expect([t3.hour, t3.minute]).toEqual([9, 0]);
    const t4 = extractTime('12am');
    expect(t4.hour).toBe(0);
  });
  test('24h form', () => {
    const t = extractTime('14:30');
    expect([t.hour, t.minute]).toEqual([14, 30]);
  });
  test('no time -> null', () => {
    expect(extractTime('tomorrow')).toBeNull();
  });
});

describe('extractDuration / extractRecurrence / cleanTitle', () => {
  test('durations', () => {
    expect(extractDuration('for 45 min').minutes).toBe(45);
    expect(extractDuration('for 1.5 hours').minutes).toBe(90);
    expect(extractDuration('30min block').minutes).toBe(30);
    expect(extractDuration('no duration here')).toBeNull();
  });
  test('recurrence', () => {
    expect(extractRecurrence('every weekday').rule).toBe('weekdays');
    expect(extractRecurrence('daily standup').rule).toBe('daily');
    expect(extractRecurrence('every week').rule).toBe('weekly');
    const r = extractRecurrence('every monday');
    expect(r.rule).toBe('weekly');
    expect(r.weekday).toBe(1);
    expect(extractRecurrence('one time')).toBeNull();
  });
  test('cleanTitle strips verbs and prepositions', () => {
    expect(cleanTitle('schedule lunch with Ana at')).toBe('lunch with Ana');
    expect(cleanTitle('add dentist on')).toBe('dentist');
  });
});

describe('parseMessage intents', () => {
  test('create: lunch with Ana tomorrow at noon', () => {
    const p = parseMessage('lunch with Ana tomorrow at noon', NOW);
    expect(p.intent).toBe('create');
    expect(p.title).toBe('lunch with Ana');
    expect(p.date).toBe('2026-10-20');
    expect(p.hour).toBe(12);
    expect(p.minutes).toBe(60);
  });
  test('create: dentist Friday 2pm', () => {
    const p = parseMessage('dentist Friday 2pm', NOW);
    expect(p.intent).toBe('create');
    expect(p.title).toBe('dentist');
    expect(p.date).toBe('2026-10-23');
    expect(p.hour).toBe(14);
  });
  test('create: standup every weekday 9am', () => {
    const p = parseMessage('standup every weekday 9am', NOW);
    expect(p.intent).toBe('create');
    expect(p.title).toBe('standup');
    expect(p.recurrence).toBe('weekdays');
    expect(p.hour).toBe(9);
  });
  test('create: with duration', () => {
    const p = parseMessage('deep work tomorrow for 45 min at 10am', NOW);
    expect(p.minutes).toBe(45);
    expect(p.hour).toBe(10);
  });
  test('move: move dentist to Thursday', () => {
    const p = parseMessage('move dentist to Thursday', NOW);
    expect(p.intent).toBe('move');
    expect(p.titleQuery).toBe('dentist');
    expect(p.date).toBe('2026-10-22');
  });
  test('move with time', () => {
    const p = parseMessage('reschedule standup to Friday 10am', NOW);
    expect(p.intent).toBe('move');
    expect(p.date).toBe('2026-10-23');
    expect(p.hour).toBe(10);
  });
  test('cancel', () => {
    const p = parseMessage('cancel lunch with Ana', NOW);
    expect(p.intent).toBe('cancel');
    expect(p.titleQuery).toBe('lunch with ana');
  });
  test('query: whats on Tuesday', () => {
    const p = parseMessage("what's on Tuesday?", NOW);
    expect(p.intent).toBe('query');
    expect(p.date).toBe('2026-10-20');
  });
  test('findfree: 30 min tomorrow afternoon', () => {
    const p = parseMessage('find 30 min free tomorrow afternoon', NOW);
    expect(p.intent).toBe('findfree');
    expect(p.date).toBe('2026-10-20');
    expect(p.minutes).toBe(30);
    expect(p.window.label).toBe('afternoon');
  });
  test('findfree: when am I free Friday', () => {
    const p = parseMessage('when am I free Friday?', NOW);
    expect(p.intent).toBe('findfree');
    expect(p.date).toBe('2026-10-23');
  });
  test('help / confirm / unknown', () => {
    expect(parseMessage('help', NOW).intent).toBe('help');
    expect(parseMessage('yes', NOW).intent).toBe('confirm');
    expect(parseMessage('blargh wibble', NOW).intent).toBe('unknown');
  });
});

describe('overlap & conflicts', () => {
  test('overlaps', () => {
    expect(overlaps('2026-10-20T10:00', '2026-10-20T11:00', '2026-10-20T10:30', '2026-10-20T11:30')).toBe(true);
    expect(overlaps('2026-10-20T10:00', '2026-10-20T11:00', '2026-10-20T11:00', '2026-10-20T12:00')).toBe(false);
    expect(overlaps('2026-10-20T10:00', '2026-10-20T11:00', '2026-10-20T09:00', '2026-10-20T10:00')).toBe(false);
  });
  test('detectConflicts filters by id', () => {
    const evs = [
      { id: 1, start: '2026-10-20T10:00', end: '2026-10-20T11:00' },
      { id: 2, start: '2026-10-20T14:00', end: '2026-10-20T15:00' },
    ];
    expect(detectConflicts('2026-10-20T10:30', '2026-10-20T11:30', evs)).toHaveLength(1);
    expect(detectConflicts('2026-10-20T10:30', '2026-10-20T11:30', evs, 1)).toHaveLength(0);
    expect(detectConflicts('2026-10-20T12:00', '2026-10-20T13:00', evs)).toHaveLength(0);
  });
});

describe('findFreeSlots', () => {
  const evs = [
    { start: '2026-10-20T10:00', end: '2026-10-20T11:00' },
    { start: '2026-10-20T14:00', end: '2026-10-20T15:30' },
  ];
  test('skips conflicts, respects working hours', () => {
    const slots = findFreeSlots('2026-10-20', 30, evs);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].start).toBe('2026-10-20T09:00');
    // no slot may overlap the busy blocks
    for (const s of slots) {
      expect(detectConflicts(s.start, s.end, evs)).toHaveLength(0);
    }
  });
  test('window clipping (afternoon)', () => {
    const slots = findFreeSlots('2026-10-20', 30, evs, 12, 17);
    for (const s of slots) {
      expect(toMin(s.start) >= toMin('2026-10-20T12:00')).toBe(true);
    }
    // 14:00-15:30 busy → first afternoon slot is 12:00
    expect(slots[0].start).toBe('2026-10-20T12:00');
  });
  test('nearMin sorts by proximity', () => {
    const slots = findFreeSlots('2026-10-20', 30, evs, 9, 18, 5, toMin('2026-10-20T16:00'));
    expect(slots[0].start).toBe('2026-10-20T15:30');
  });
  test('no room -> empty', () => {
    const full = [{ start: '2026-10-20T09:00', end: '2026-10-20T18:00' }];
    expect(findFreeSlots('2026-10-20', 30, full)).toHaveLength(0);
  });
  test('big gap offers stepped start times', () => {
    const slots = findFreeSlots('2026-10-20', 30, [], 9, 12, 5);
    expect(slots.length).toBeGreaterThan(3);
    expect(slots[0].start).toBe('2026-10-20T09:00');
    expect(slots[1].start).toBe('2026-10-20T09:15');
  });
});

describe('recurrence expansion', () => {
  test('daily', () => {
    const ev = { id: 1, title: 'x', start: '2026-10-19T09:00', end: '2026-10-19T09:30', rrule: 'daily' };
    const occ = expandRecurrence(ev, '2026-10-19', '2026-10-21');
    expect(occ.map((o) => o.start)).toEqual([
      '2026-10-19T09:00', '2026-10-20T09:00', '2026-10-21T09:00',
    ]);
    expect(occ[0].occurrenceOf).toBe(1);
  });
  test('weekly keeps weekday', () => {
    const ev = { id: 1, title: 'x', start: '2026-10-19T09:00', end: '2026-10-19T10:00', rrule: 'weekly' };
    const occ = expandRecurrence(ev, '2026-10-19', '2026-11-02');
    expect(occ.map((o) => o.start.slice(0, 10))).toEqual([
      '2026-10-19', '2026-10-26', '2026-11-02',
    ]);
  });
  test('weekdays skips weekend', () => {
    const ev = { id: 1, title: 'x', start: '2026-10-23T09:00', end: '2026-10-23T09:15', rrule: 'weekdays' };
    const occ = expandRecurrence(ev, '2026-10-23', '2026-10-27');
    expect(occ.map((o) => o.start.slice(0, 10))).toEqual([
      '2026-10-23', '2026-10-26', '2026-10-27',
    ]);
  });
  test('non-recurring outside range -> empty', () => {
    const ev = { id: 1, title: 'x', start: '2026-10-19T09:00', end: '2026-10-19T10:00', rrule: null };
    expect(expandRecurrence(ev, '2026-10-20', '2026-10-21')).toHaveLength(0);
  });
  test('rrule_until respected', () => {
    const ev = { id: 1, title: 'x', start: '2026-10-19T09:00', end: '2026-10-19T09:30', rrule: 'daily', rrule_until: '2026-10-20' };
    expect(expandRecurrence(ev, '2026-10-19', '2026-10-25')).toHaveLength(2);
  });
});

describe('matchEvents & formatting', () => {
  const evs = [
    { id: 1, title: 'Lunch with Ana', start: '2026-10-20T12:00', end: '2026-10-20T13:00' },
    { id: 2, title: 'Dentist', start: '2026-10-23T14:00', end: '2026-10-23T15:00' },
    { id: 3, title: 'Lunch with Marco', start: '2026-10-21T12:00', end: '2026-10-21T13:00' },
  ];
  test('matches by word, upcoming first', () => {
    const m = matchEvents('lunch with Ana', evs, NOW);
    expect(m.map((e) => e.id)).toEqual([1, 3]);
  });
  test('no match -> empty', () => {
    expect(matchEvents('xyzzy', evs, NOW)).toHaveLength(0);
  });
  test('formatTime', () => {
    expect(formatTime('2026-10-20T14:30')).toBe('2:30 PM');
    expect(formatTime('2026-10-20T09:05')).toBe('9:05 AM');
    expect(formatTime('2026-10-20T00:00')).toBe('12:00 AM');
  });
  test('formatDay', () => {
    expect(formatDay('2026-10-19', NOW)).toBe('today');
    expect(formatDay('2026-10-20', NOW)).toBe('tomorrow');
    expect(formatDay('2026-10-23', NOW)).toBe('Friday');
  });
});

describe('toMin/fromMin round trip', () => {
  test('round trip', () => {
    const s = '2026-10-20T14:30';
    expect(fromMin(toMin(s))).toBe(s);
  });
});
