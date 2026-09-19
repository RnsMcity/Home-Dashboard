import test from 'node:test';
import assert from 'node:assert/strict';

import { parseICS } from '../server/calendar/ics.js';
import { parseIcalDate, addDuration, wallToUtc } from '../server/ical-time.js';
import { selectEvents } from '../public/calendar.js';

const FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Home
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20260919T150000
DTEND;TZID=America/Los_Angeles:20260919T160000
SUMMARY:Dentist\\, 2nd floor; suite 4B
STATUS:CONFIRMED
UID:evt-1@google.com
END:VEVENT
BEGIN:VEVENT
DTSTART:20260920T093000Z
DTEND:20260920T103000Z
SUMMARY:Team standup (UTC)
UID:evt-2@google.com
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260921
DTEND;VALUE=DATE:20260922
SUMMARY:Family birthday party
UID:evt-3@google.com
END:VEVENT
BEGIN:VEVENT
DTSTART:20260925T180000
SUMMARY:Floating dinner (no end)
DURATION:PT2H
UID:evt-4@google.com
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20260918T150000
SUMMARY:Cancelled thing
STATUS:CANCELLED
UID:evt-5@google.com
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20260917T090000
DTEND;TZID=America/Los_Angeles:20260917T100000
SUMMARY:Long past event
UID:evt-6@google.com
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20261005T120000
SUMMARY:Far future (beyond horizon)
UID:evt-7@google.com
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20260919T140000
SUMMARY:Multi-line\\nsummary with a
  second line and ; semicolons
UID:evt-8@google.com
END:VEVENT
END:VCALENDAR
`;

test('parseICS extracts events from a Google-style feed', () => {
  const events = parseICS(FIXTURE);
  const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));

  // All valid VEVENTs are parsed (time filtering happens later in selectEvents).
  assert.equal(Object.keys(byTitle).length, 7);
  assert.ok(!('Cancelled thing' in byTitle), 'CANCELLED events must be dropped');
  assert.ok(byTitle['Long past event'], 'past events are still parsed');

  const dentist = byTitle['Dentist, 2nd floor; suite 4B'];
  assert.ok(dentist, `escaped title not found: ${JSON.stringify(Object.keys(byTitle))}`);
  // 15:00 PDT (UTC-7) on 2026-09-19 == 22:00Z — absolute UTC, TZ-independent.
  assert.equal(dentist.start, '2026-09-19T22:00:00.000Z');
  assert.equal(dentist.end, '2026-09-19T23:00:00.000Z');
  assert.equal(dentist.allDay, false);

  const standup = byTitle['Team standup (UTC)'];
  assert.equal(standup.start, '2026-09-20T09:30:00.000Z');

  const birthday = byTitle['Family birthday party'];
  assert.equal(birthday.allDay, true);
  // All-day start is local midnight of the event date (machine-TZ relative).
  const bStart = new Date(birthday.start);
  assert.equal(bStart.getHours(), 0);
  assert.equal(bStart.getMinutes(), 0);
  assert.equal(bStart.getDate(), 21);

  const dinner = byTitle['Floating dinner (no end)'];
  // DURATION:PT2H extends the floating local start.
  const dStart = new Date(dinner.start);
  const dEnd = new Date(dinner.end);
  assert.equal(dEnd.getTime() - dStart.getTime(), 2 * 3600_000);
  assert.equal(dEnd.getHours(), 20); // local 18:00 + 2h

  const multiline = byTitle['Multi-line summary with a second line and ; semicolons'];
  assert.ok(multiline, 'unfolded/escaped multi-line title not found');
});

test('parseICS tolerates garbage input', () => {
  assert.deepEqual(parseICS(''), []);
  assert.deepEqual(parseICS('not an ics at all\nrandom lines'), []);
  const partial = parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:no dates here\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(partial.length, 0); // no DTSTART -> dropped
});

test('parseIcalDate handles UTC, floating and TZID forms', () => {
  const utc = parseIcalDate('20260918T150000Z');
  assert.equal(utc.date.toISOString(), '2026-09-18T15:00:00.000Z');

  const floating = parseIcalDate('20260918T150000');
  assert.equal(floating.date.getHours(), new Date(2026, 8, 18, 15).getHours()); // local wall time preserved

  const tz = parseIcalDate('20260918T150000', { TZID: 'America/Los_Angeles' });
  assert.equal(tz.date.toISOString(), '2026-09-18T22:00:00.000Z'); // PDT = UTC-7

  const allDay = parseIcalDate('20260918', { VALUE: 'DATE' });
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.date.getFullYear(), 2026);
});

test('wallToUtc resolves DST boundaries correctly', () => {
  // Winter (PST, UTC-8): 15:00 -> 23:00Z
  const winter = wallToUtc('America/Los_Angeles', 2026, 1, 15, 15, 0, 0);
  assert.equal(winter.toISOString(), '2026-01-15T23:00:00.000Z');
  // Summer (PDT, UTC-7): 15:00 -> 22:00Z
  const summer = wallToUtc('America/Los_Angeles', 2026, 7, 15, 15, 0, 0);
  assert.equal(summer.toISOString(), '2026-07-15T22:00:00.000Z');
});

test('addDuration parses RFC 5545 durations', () => {
  const start = new Date(Date.UTC(2026, 8, 19, 12));
  assert.equal(addDuration(start, 'PT2H').toISOString(), '2026-09-19T14:00:00.000Z');
  assert.equal(addDuration(start, 'P1DT3H').toISOString(), '2026-09-20T15:00:00.000Z');
  assert.equal(addDuration(start, '-PT30M').toISOString(), '2026-09-19T11:30:00.000Z');
  assert.equal(addDuration(start, 'garbage'), null);
});

// --- selection logic (shared with the UI) ----------------------------------

function ev(title, startIso, endIso = null, allDay = false) {
  return { title, start: startIso, end: endIso, allDay };
}

test('selectEvents keeps upcoming events within the horizon', () => {
  const now = new Date(Date.UTC(2026, 8, 19, 12)); // Sat Sep 19 noon UTC
  const events = [
    ev('past', '2026-09-18T10:00:00.000Z', '2026-09-18T11:00:00.000Z'),
    ev('today-later', '2026-09-19T15:00:00.000Z', '2026-09-19T16:00:00.000Z'),
    ev('tomorrow', '2026-09-20T09:00:00.000Z', '2026-09-20T10:00:00.000Z'),
    ev('beyond-horizon', '2026-10-10T09:00:00.000Z', '2026-10-10T10:00:00.000Z'),
  ];
  const picked = selectEvents(events, now, { maxEvents: 5 });
  assert.deepEqual(
    picked.map((e) => e.title),
    ['today-later', 'tomorrow'], // sorted by start; past + beyond horizon dropped
  );
});

test('selectEvents respects maxEvents and all-day boundaries', () => {
  const now = new Date(Date.UTC(2026, 8, 19, 12));
  const events = [
    ev('a', '2026-09-19T13:00:00.000Z'),
    ev('b', '2026-09-19T14:00:00.000Z'),
    ev('c', '2026-09-19T15:00:00.000Z'),
  ];
  assert.equal(selectEvents(events, now, { maxEvents: 2 }).length, 2);

  // All-day event ending at local midnight of "today" is already over.
  const allDayOver = ev('over', '2026-09-18T07:00:00.000Z', '2026-09-19T07:00:00.000Z', true);
  assert.equal(selectEvents([allDayOver], now, { maxEvents: 5 }).length, 0);

  // All-day event spanning today is shown.
  const allDayToday = ev('today-all', '2026-09-19T07:00:00.000Z', '2026-09-20T07:00:00.000Z', true);
  assert.equal(selectEvents([allDayToday], now, { maxEvents: 5 }).length, 1);
});

// --- recurrence expansion ----------------------------------------------------

const NOW = new Date(Date.UTC(2026, 8, 19, 12)); // Sat Sep 19 noon UTC

function localDateParts(iso) {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

test('weekly all-day series expands to upcoming Mondays', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260914
DTEND;VALUE=DATE:20260915
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Monday all-day thing
UID:r-1@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW);
  // Mondays Sep 14 .. Dec 14 (expansion window ends Dec 18). Machine-TZ relative.
  assert.equal(events.length, 14);
  for (const e of events) {
    assert.equal(e.allDay, true);
    assert.equal(e.title, 'Monday all-day thing');
  }
  const monday = events.find((e) => localDateParts(e.start).join('-') === '2026-9-21');
  assert.ok(monday, `Sep 21 occurrence missing: ${events.map((e) => e.start).join(', ')}`);
  // Exclusive all-day end: next local midnight.
  const mEnd = new Date(monday.end);
  assert.equal(mEnd.getDate(), 22);
  assert.equal(mEnd.getHours(), 0);
});

test('weekly series keeps wall time stable across DST', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20261028T090000
RRULE:FREQ=WEEKLY;BYDAY=WE
SUMMARY:Wednesday call
UID:r-2@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, new Date(Date.UTC(2026, 10, 3, 12))); // Nov 3 noon UTC
  const starts = events.map((e) => e.start);
  assert.ok(starts.includes('2026-10-28T16:00:00.000Z'), `PDT occurrence wrong: ${starts.join(',')}`); // 09:00 UTC-7
  assert.ok(starts.includes('2026-11-04T17:00:00.000Z'), `PST occurrence wrong: ${starts.join(',')}`); // 09:00 UTC-8
});

test('RRULE COUNT limits total occurrences', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260916
RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3
SUMMARY:Three only
UID:r-3@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW);
  assert.deepEqual(events.map((e) => localDateParts(e.start)), [
    [2026, 9, 16],
    [2026, 9, 23],
    [2026, 9, 30],
  ]);
});

test('RRULE UNTIL stops the series (inclusive)', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260914
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260928
SUMMARY:Until late Sep
UID:r-4@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW);
  assert.deepEqual(events.map((e) => localDateParts(e.start)), [
    [2026, 9, 14],
    [2026, 9, 21],
    [2026, 9, 28],
  ]);
});

test('EXDATE removes individual occurrences', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260914
DTEND;VALUE=DATE:20260915
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;VALUE=DATE:20260921
SUMMARY:Skipped week
UID:r-5@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW);
  assert.equal(events.length, 13);
  assert.ok(!events.some((e) => localDateParts(e.start).join('-') === '2026-9-21'));
});

test('RECURRENCE-ID override replaces the generated instance', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260914
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Weekly thing
UID:r-6@google.com
END:VEVENT
BEGIN:VEVENT
RECURRENCE-ID;VALUE=DATE:20260928
DTSTART;VALUE=DATE:20260928
SUMMARY:Moved thing
UID:r-6@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW);
  assert.equal(events.filter((e) => e.title === 'Moved thing').length, 1);
  assert.ok(!events.some((e) => e.title === 'Weekly thing' && localDateParts(e.start).join('-') === '2026-9-28'));
});

test('unsupported RRULE falls back to the anchor occurrence only', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=America/Los_Angeles:20260915T090000
RRULE:FREQ=HOURLY;INTERVAL=30
SUMMARY:Hourly
UID:r-7@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].start, '2026-09-15T16:00:00.000Z'); // 09:00 PDT
});

test('daily series with INTERVAL skips days', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20260915T170000Z
RRULE:FREQ=DAILY;INTERVAL=2
SUMMARY:Every other day
UID:r-8@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW);
  const starts = events.map((e) => e.start.slice(0, 10));
  assert.ok(starts.includes('2026-09-15'));
  assert.ok(!starts.includes('2026-09-18'), 'odd day must be skipped');
  assert.ok(starts.includes('2026-09-19'));
});

test('monthly series with negative BYMONTHDAY hits month ends', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260930
RRULE:FREQ=MONTHLY;BYMONTHDAY=-1
SUMMARY:Last day of month
UID:r-9@google.com
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, NOW); // window ends Dec 18 -> no Dec 31
  assert.deepEqual(events.map((e) => localDateParts(e.start)), [
    [2026, 9, 30],
    [2026, 10, 31],
    [2026, 11, 30],
  ]);
});
