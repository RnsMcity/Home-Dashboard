import { parseIcalDateParts, partsToDate, addDuration } from '../ical-time.js';

export class CalendarError extends Error {}

// --- recurrence expansion ----------------------------------------------------
// Feeds (Google included) send recurring series as one master VEVENT with an
// RRULE; future occurrences must be generated. Expansion is bounded to a window
// around "now" — wide enough that the disk cache stays useful through long
// outages, small enough that infinite series cost nothing.

const WD_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const BYDAY_RE = /^([+-]?)(\d{0,2})(SU|MO|TU|WE|TH|FR|SA)$/;

const EXPAND_PAST_DAYS = 7;
const EXPAND_FUTURE_DAYS = 90;
const MAX_EXPAND_ITERATIONS = 20_000; // ~54 years of daily steps, hard safety cap

/** Parse an RRULE into a normalized shape, or null if unsupported. */
function parseRrule(value) {
  const rule = {};
  for (const seg of String(value ?? '').split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const key = seg.slice(0, eq).toUpperCase();
    const val = seg.slice(eq + 1);
    if (key === 'FREQ') rule.freq = val.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = Math.max(1, Number.parseInt(val, 10) || 1);
    else if (key === 'COUNT') rule.count = Number.parseInt(val, 10);
    else if (key === 'UNTIL') rule.until = val;
    else if (key === 'BYMONTH') rule.bymonth = val.split(',').map(Number);
    else if (key === 'BYMONTHDAY') rule.bymonthday = val.split(',').map(Number);
    else if (key === 'BYDAY') {
      rule.byday = [];
      for (const b of val.split(',').map((s) => s.trim().toUpperCase())) {
        const m = BYDAY_RE.exec(b);
        if (!m) return null;
        rule.byday.push({ n: m[2] ? Number(m[1] + m[2]) : null, wd: m[3] });
      }
    }
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return null;
  // Ordinals (2MO, -1FR) are monthly/yearly semantics; plain weekdays only for weekly.
  if (rule.byday?.some((b) => b.n !== null && rule.freq === 'WEEKLY')) return null;
  if (rule.freq === 'YEARLY' && rule.byday?.some((b) => b.n === null)) return null;
  return { interval: 1, ...rule };
}

const dayMs = (y, mo, d) => Date.UTC(y, mo - 1, d); // exact calendar math, no DST

function shiftDay(p, days) {
  const t = new Date(dayMs(p.y, p.mo, p.d) + days * 86400_000);
  // Spread so kind/time fields survive for partsToDate.
  return { ...p, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const weekdayOf = (y, mo, d) => new Date(dayMs(y, mo, d)).getUTCDay(); // SU=0..SA=6
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** Integer week index with Monday as the first day (RFC default WKST). */
function weekIndexOf(y, mo, d) {
  const offsetToMonday = (weekdayOf(y, mo, d) + 6) % 7;
  return Math.floor((dayMs(y, mo, d) - offsetToMonday * 86400_000) / (7 * 86400_000));
}

/** Day-of-month of the nth weekday in a month (n>0 from start, n<0 from end), or null. */
function ordinalWeekdayDay(y, mo, n, wdName) {
  const lim = daysInMonth(y, mo);
  const target = WEEKDAY_INDEX[wdName];
  if (n > 0) {
    const firstWd = 1 + ((target - weekdayOf(y, mo, 1) + 7) % 7);
    const day = firstWd + (n - 1) * 7;
    return day <= lim ? day : null;
  }
  if (n < 0) {
    const lastWd = lim - ((weekdayOf(y, mo, lim) - target + 7) % 7);
    const day = lastWd + (n + 1) * 7;
    return day >= 1 ? day : null;
  }
  return null;
}

/** Does calendar day `dp` match the rule anchored at date parts `a`? */
function dayMatches(rule, a, dp) {
  const spanDays = Math.round((dayMs(dp.y, dp.mo, dp.d) - dayMs(a.y, a.mo, a.d)) / 86400_000);
  if (spanDays < 0) return false;
  switch (rule.freq) {
    case 'DAILY':
      return spanDays % rule.interval === 0;
    case 'WEEKLY': {
      const wd = WD_NAMES[weekdayOf(dp.y, dp.mo, dp.d)];
      if (rule.byday?.length ? !rule.byday.some((b) => b.wd === wd && b.n === null) : wd !== WD_NAMES[weekdayOf(a.y, a.mo, a.d)]) {
        return false;
      }
      return (weekIndexOf(dp.y, dp.mo, dp.d) - weekIndexOf(a.y, a.mo, a.d)) % rule.interval === 0;
    }
    case 'MONTHLY': {
      const monthSpan = (dp.y - a.y) * 12 + (dp.mo - a.mo);
      if (monthSpan < 0 || monthSpan % rule.interval !== 0) return false;
      const lim = daysInMonth(dp.y, dp.mo);
      if (rule.bymonthday?.length) {
        return rule.bymonthday.some((n) => {
          const target = n > 0 ? n : lim + n + 1;
          return dp.d === target && target >= 1 && target <= lim;
        });
      }
      if (rule.byday?.length) {
        return rule.byday.some((b) =>
          b.n === null ? WD_NAMES[weekdayOf(dp.y, dp.mo, dp.d)] === b.wd : ordinalWeekdayDay(dp.y, dp.mo, b.n, b.wd) === dp.d,
        );
      }
      // Plain monthly: same day-of-month; months without that day are skipped.
      return dp.d === a.d && dp.d <= lim;
    }
    case 'YEARLY': {
      const yearSpan = dp.y - a.y;
      if (yearSpan < 0 || yearSpan % rule.interval !== 0) return false;
      if (rule.bymonth?.length && !rule.bymonth.includes(dp.mo)) return false;
      if (rule.bymonthday?.length) {
        const lim = daysInMonth(dp.y, dp.mo);
        return rule.bymonthday.some((n) => {
          const target = n > 0 ? n : lim + n + 1;
          return dp.d === target && target >= 1 && target <= lim;
        });
      }
      if (rule.byday?.length) {
        const monthOk = rule.bymonth?.length ? true : dp.mo === a.mo;
        return monthOk && rule.byday.some((b) => ordinalWeekdayDay(dp.y, dp.mo, b.n, b.wd) === dp.d);
      }
      // Plain yearly: anniversary date (Feb 29 simply doesn't match non-leap years).
      return dp.mo === a.mo && dp.d === a.d;
    }
    default:
      return false;
  }
}

/**
 * Expand a recurrence into occurrences within [winStartMs, winEndMs].
 * Returns [{parts, ms}] or null if the rule is malformed (caller falls back to
 * emitting just the anchor occurrence). Wall time stays stable across DST.
 */
function expandOccurrences(anchor, rule, exdateMs, overrideMs, winStartMs, winEndMs) {
  let untilParts = null;
  if (rule.until) {
    untilParts = parseIcalDateParts(rule.until);
    if (!untilParts) return null;
  }
  const out = [];
  let seen = 0; // COUNT includes occurrences before the window
  let day = { y: anchor.y, mo: anchor.mo, d: anchor.d };
  for (let i = 0; i < MAX_EXPAND_ITERATIONS; i++) {
    if (!dayMatches(rule, anchor, day)) {
      day = shiftDay(day, 1);
      continue;
    }
    const parts = { ...anchor, y: day.y, mo: day.mo, d: day.d };
    const ms = partsToDate(parts).getTime();
    if (untilParts && dayMs(day.y, day.mo, day.d) > dayMs(untilParts.y, untilParts.mo, untilParts.d)) break;
    seen++;
    if (rule.count && seen > rule.count) break;
    if (ms >= winStartMs && ms <= winEndMs && !exdateMs.has(ms) && !overrideMs.has(ms)) {
      out.push({ parts, ms });
    }
    if (ms > winEndMs) break; // occurrences are monotonic — nothing more can land in the window
    day = shiftDay(day, 1);
  }
  return out;
}

/** End instant for an occurrence, mirroring how a single event's end is derived. */
function occurrenceEnd(raw, anchorParts, anchorMs, occ) {
  if (raw.dtend) {
    const endParts = parseIcalDateParts(raw.dtend.value, raw.dtend.params ?? {});
    if (!endParts) return null;
    if (anchorParts.kind === 'date') {
      // Exclusive all-day DTEND: keep the day span exact across DST.
      const spanDays = Math.round(
        (dayMs(endParts.y, endParts.mo, endParts.d) - dayMs(anchorParts.y, anchorParts.mo, anchorParts.d)) / 86400_000,
      );
      return partsToDate(shiftDay(occ.parts, spanDays)).getTime();
    }
    return occ.ms + (partsToDate(endParts).getTime() - anchorMs);
  }
  if (raw.duration) {
    const end = addDuration(new Date(occ.ms), raw.duration);
    return end ? end.getTime() : null;
  }
  return null;
}

/** Unfold RFC 5545 continuation lines (leading space/tab). */
function unfold(lines) {
  const out = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Unescape iCalendar TEXT values (\, \; \\ \N). */
function unescapeText(s) {
  return String(s ?? '').replace(/\\(n|N|,|;|\\)/g, (_, g) => (g === 'n' || g === 'N' ? ' ' : g));
}

/** Split "NAME;P1=v1;P2='v 2':value" into {name, params, value}. */
function parseProperty(line) {
  let sep = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      sep = i;
      break;
    }
  }
  if (sep < 0) return null;

  const head = line.slice(0, sep);
  const value = unescapeText(line.slice(sep + 1));

  // Split name/params on unquoted semicolons.
  const segments = [];
  let cur = '';
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ';' && !inQuotes) {
      segments.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  segments.push(cur);

  const name = segments.shift();
  if (!name) return null;
  const params = {};
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const key = seg.slice(0, eq).toUpperCase();
    let val = seg.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name: name.toUpperCase(), params, value };
}

/**
 * Parse an ICS document into events. Tolerant by design: malformed blocks or
 * properties are skipped, never thrown. Recurring series are expanded to the
 * occurrences falling in [now-7d, now+90d]; unsupported RRULEs fall back to
 * just the anchor occurrence.
 * @returns {Array<{title: string, start: string, end: string|null, allDay: boolean}>}
 */
export function parseICS(text, now = new Date()) {
  const lines = unfold(String(text ?? '').replace(/\r\n/g, '\n').split('\n'));
  const rawEvents = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) rawEvents.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const prop = parseProperty(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'SUMMARY':
        current.summary = prop.value;
        break;
      case 'DTSTART':
        current.dtstart = { value: prop.value, params: prop.params };
        break;
      case 'DTEND':
        current.dtend = { value: prop.value, params: prop.params };
        break;
      case 'DURATION':
        current.duration = prop.value;
        break;
      case 'STATUS':
        if (prop.value.toUpperCase() === 'CANCELLED') current.cancelled = true;
        break;
      case 'RRULE':
        current.rrule = prop.value;
        break;
      case 'EXDATE':
        (current.exdates ??= []).push({ value: prop.value, params: prop.params });
        break;
      case 'RECURRENCE-ID':
        current.recurrenceId = { value: prop.value, params: prop.params };
        break;
      default:
        break; // DESCRIPTION, LOCATION, VALARM, etc. are not needed for display
    }
  }

  // Dates carrying a RECURRENCE-ID override an individual series instance. The
  // generated occurrence for that date is skipped; the override VEVENT itself
  // is emitted as its own event below (cancelled ones already dropped).
  const overrideMs = new Set();
  for (const raw of rawEvents) {
    if (!raw?.recurrenceId) continue;
    const p = parseIcalDateParts(raw.recurrenceId.value, raw.recurrenceId.params);
    if (p) overrideMs.add(partsToDate(p).getTime());
  }

  const winStartMs = now.getTime() - EXPAND_PAST_DAYS * 86400_000;
  const winEndMs = now.getTime() + EXPAND_FUTURE_DAYS * 86400_000;

  const events = [];
  for (const raw of rawEvents) {
    if (!raw || raw.cancelled) continue;
    const anchorParts = parseIcalDateParts(raw.dtstart?.value, raw.dtstart?.params ?? {});
    if (!anchorParts) continue;
    const anchorMs = partsToDate(anchorParts).getTime();

    let occurrences = [{ parts: anchorParts, ms: anchorMs }];
    if (raw.rrule) {
      const rule = parseRrule(raw.rrule);
      if (rule) {
        const exdateMs = new Set();
        for (const x of raw.exdates ?? []) {
          for (const part of String(x.value).split(',')) {
            const p = parseIcalDateParts(part.trim(), x.params);
            if (p) exdateMs.add(partsToDate(p).getTime());
          }
        }
        const expanded = expandOccurrences(anchorParts, rule, exdateMs, overrideMs, winStartMs, winEndMs);
        if (expanded && expanded.length > 0) occurrences = expanded;
      }
    }

    for (const occ of occurrences) {
      const end = occurrenceEnd(raw, anchorParts, anchorMs, occ);
      events.push({
        title: raw.summary || '(no title)',
        start: new Date(occ.ms).toISOString(),
        end: end ? new Date(end).toISOString() : null,
        allDay: anchorParts.kind === 'date',
      });
    }
  }
  return events;
}

/** Fetch + parse a calendar feed (e.g. a public Google ICS URL). */
export async function fetchCalendar(cfg) {
  if (!cfg?.feedUrl) throw new CalendarError('calendar feed not configured');
  let res;
  try {
    res = await fetch(cfg.feedUrl, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': 'HomeDashboard/1.0 (self-hosted wall display)',
        Accept: 'text/calendar, text/plain',
      },
    });
  } catch (err) {
    throw new CalendarError(`network error: ${err.message}`);
  }
  if (!res.ok) throw new CalendarError(`HTTP ${res.status} from calendar feed`);
  const text = await res.text();
  return parseICS(text);
}
