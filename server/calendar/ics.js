import { parseIcalDate, addDuration } from '../ical-time.js';

export class CalendarError extends Error {}

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
 * properties are skipped, never thrown.
 * @returns {Array<{title: string, start: string, end: string|null, allDay: boolean}>}
 */
export function parseICS(text) {
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
      default:
        break; // DESCRIPTION, LOCATION, VALARM, etc. are not needed for display
    }
  }

  const events = [];
  for (const raw of rawEvents) {
    if (!raw || raw.cancelled) continue;
    const start = parseIcalDate(raw.dtstart?.value, raw.dtstart?.params ?? {});
    if (!start?.date) continue;

    let end = null;
    if (raw.dtend) {
      const e = parseIcalDate(raw.dtend.value, raw.dtend.params ?? {});
      end = e?.date ?? null;
    } else if (raw.duration) {
      end = addDuration(start.date, raw.duration);
    }

    events.push({
      title: raw.summary || '(no title)',
      start: start.date.toISOString(),
      end: end ? end.toISOString() : null,
      allDay: start.allDay,
    });
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
