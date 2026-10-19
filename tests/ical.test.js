// tests/ical.test.js — bun test for src/ical.js
import { describe, test, expect } from 'bun:test';
import { parseIcs, expandIcal, mergeBusyBlocks, wallToLocal, fmtLocal } from '../src/ical.js';

const SRC = 'iCal feed';
const from = new Date(2026, 9, 19, 0, 0);
const to = new Date(2026, 10, 19, 0, 0);

describe('parseIcs basics', () => {
  test('UTC (Z) timestamps', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:1
SUMMARY:Standup
DTSTART:20261020T130000Z
DTEND:20261020T133000Z
END:VEVENT
END:VCALENDAR`;
    const [e] = parseIcs(ics);
    expect(e.title).toBe('Standup');
    expect(e.uid).toBe('1');
    // 13:00Z → local time; compute expectation from the runtime TZ
    const blocks = expandIcal([e], from, to, SRC);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].external).toBe(true);
    expect(blocks[0].source).toBe(SRC);
    const ref = new Date(Date.UTC(2026, 9, 20, 13, 0));
    expect(blocks[0].start).toBe(fmtLocal(ref));
    expect(blocks[0].end).toBe(fmtLocal(new Date(ref.getTime() + 30 * 60000)));
  });

  test('floating timestamps treated as server-local', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:2
SUMMARY:Lunch
DTSTART:20261021T120000
DTEND:20261021T130000
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    expect(blocks[0].start).toBe('2026-10-21T12:00');
    expect(blocks[0].end).toBe('2026-10-21T13:00');
  });

  test('TZID wall clock converts to local', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:3
SUMMARY:Call
DTSTART;TZID=America/New_York:20261022T150000
DTEND;TZID=America/New_York:20261022T153000
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    // wall clock 15:00 in America/New_York; compare against the same instant
    const ref = wallToLocal(2026, 10, 22, 15, 0, 'America/New_York');
    expect(blocks[0].start).toBe(fmtLocal(ref));
    expect(blocks[0].end).toBe(fmtLocal(new Date(ref.getTime() + 30 * 60000)));
  });

  test('multi-day event', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:4
SUMMARY:Conference
DTSTART:20261025T090000
DTEND:20261027T170000
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    expect(blocks[0].start).toBe('2026-10-25T09:00');
    expect(blocks[0].end).toBe('2026-10-27T17:00');
  });

  test('folded lines + escaped commas', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:5
SUMMARY:Very long title that is fol
 ded across two lines\\, with comma
DTSTART:20261026T090000
DTEND:20261026T100000
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    expect(blocks[0].title).toBe('Very long title that is folded across two lines, with comma');
  });

  test('skips events with no DTSTART', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:6
SUMMARY:Broken
END:VEVENT
END:VCALENDAR`;
    expect(parseIcs(ics)).toHaveLength(0);
  });
});

describe('RRULE expansion', () => {
  test('daily expansion within window', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:7
SUMMARY:Gym
DTSTART:20261001T070000
DTEND:20261001T080000
RRULE:FREQ=DAILY
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    // Oct 19 .. Nov 18 inclusive → 31 occurrences
    expect(blocks).toHaveLength(31);
    expect(blocks[0].start).toBe('2026-10-19T07:00');
    expect(blocks[30].start).toBe('2026-11-18T07:00');
  });

  test('weekly expansion', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:8
SUMMARY:1:1
DTSTART:20261001T100000
DTEND:20261001T103000
RRULE:FREQ=WEEKLY;COUNT=4
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    // COUNT=4 → Oct 1, 8, 15, 22; window starts Oct 19 so only Oct 22 shows
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBe('2026-10-22T10:00');
  });

  test('COUNT bounds expansion', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:9
SUMMARY:Dose
DTSTART:20261019T080000
DTEND:20261019T081500
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    expect(blocks).toHaveLength(3);
  });

  test('UNTIL bounds expansion', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:10
SUMMARY:Pills
DTSTART:20261019T080000
DTEND:20261019T081500
RRULE:FREQ=DAILY;UNTIL=20261021T235959Z
END:VEVENT
END:VCALENDAR`;
    const blocks = expandIcal(parseIcs(ics), from, to, SRC);
    expect(blocks).toHaveLength(3);
  });
});

describe('mergeBusyBlocks', () => {
  test('overlaps coalesce, disjoint stay separate', () => {
    const out = mergeBusyBlocks([
      { start: '2026-10-20T10:00', end: '2026-10-20T11:00', title: 'A', source: 's', external: true },
      { start: '2026-10-20T10:30', end: '2026-10-20T12:00', title: 'B', source: 's', external: true },
      { start: '2026-10-20T14:00', end: '2026-10-20T15:00', title: 'C', source: 's', external: true },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].start).toBe('2026-10-20T10:00');
    expect(out[0].end).toBe('2026-10-20T12:00');
    expect(out[0].title).toBe('A + B');
    expect(out[1].title).toBe('C');
  });

  test('external flag survives the merge (never writable)', () => {
    const out = mergeBusyBlocks([
      { start: '2026-10-20T10:00', end: '2026-10-20T11:00', title: 'A', source: 's', external: true },
    ]);
    expect(out[0].external).toBe(true);
    expect(out[0].id).toBeUndefined(); // no id → no DB target → agent can never edit/delete
  });
});

describe('wallToLocal', () => {
  test('resolves the right instant for a named zone', () => {
    const d = wallToLocal(2026, 10, 20, 9, 30, 'America/New_York');
    // 09:30 EDT == 13:30 UTC, regardless of runtime TZ
    expect(d.getTime()).toBe(Date.UTC(2026, 9, 20, 13, 30));
  });
});
