// Pure iCalendar date/time handling (RFC 5545 subset). No DOM, no network —
// fully unit-testable. Handles the three value shapes real feeds use:
//   VALUE=DATE / YYYYMMDD            -> all-day (local)
//   YYYYMMDDTHHMMSSZ                 -> UTC
//   YYYYMMDDTHHMMSS [;TZID=<iana>]   -> floating local, or IANA-zone wall time

const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** Offset (ms) of an IANA zone relative to UTC at a given instant, via Intl. */
export function tzOffsetMs(timeZone, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - utcMs;
}

/** Convert wall-clock time in an IANA zone to a UTC Date (iterative offset). */
export function wallToUtc(timeZone, y, mo, d, h, mi, s) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = wall;
  for (let i = 0; i < 3; i++) utc = wall - tzOffsetMs(timeZone, utc);
  return new Date(utc);
}

/** True when Intl accepts the zone name. */
export function isKnownTimeZone(name) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse an iCalendar date or date-time value.
 * @returns {{date: Date, allDay: boolean} | null}
 */
export function parseIcalDate(value, params = {}) {
  const v = String(value ?? '').trim();
  if (!v) return null;

  let m = DATE_ONLY.exec(v);
  if (m || params.VALUE === 'DATE') {
    // All-day: local midnight of that date.
    if (!m) return null;
    return { date: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  }

  m = DATE_TIME.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === 'Z') {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  }
  const tzid = params.TZID;
  if (tzid && isKnownTimeZone(tzid)) {
    return { date: wallToUtc(tzid, +y, +mo, +d, +h, +mi, +s), allDay: false };
  }
  // Floating time: interpret in the local timezone.
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

/** Parse an RFC 5545 duration like "PT2H30M" and add it to a start time. */
export function addDuration(start, duration) {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    String(duration ?? '').trim(),
  );
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const ms =
    sign *
    ((+(m[2] ?? 0)) * 7 * 86400_000 +
      (+(m[3] ?? 0)) * 86400_000 +
      (+(m[4] ?? 0)) * 3600_000 +
      (+(m[5] ?? 0)) * 60_000 +
      (+(m[6] ?? 0)) * 1000);
  return new Date(start.getTime() + ms);
}
