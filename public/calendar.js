// Calendar panel. Polls /api/calendar; the server gates feed fetches with a
// TTL and serves its last successful parse when the feed is unreachable.
// A broken or empty feed never affects the rest of the dashboard — worst case
// the panel hides itself.

const HORIZON_DAYS = 14; // how far ahead "upcoming" reaches
const POLL_MS = 5 * 60_000;

/**
 * Pick the events to display: still upcoming (or ongoing), within the
 * horizon, sorted by start time, capped at maxEvents. Pure — shared with tests.
 */
export function selectEvents(events, now, { maxEvents = 6 } = {}) {
  const nowMs = now.getTime();
  const horizonEnd = nowMs + HORIZON_DAYS * 86400_000;
  return (events ?? [])
    .filter((e) => {
      const start = Date.parse(e.start);
      if (Number.isNaN(start)) return false;
      const end = e.end ? Date.parse(e.end) : start;
      return end >= nowMs && start < horizonEnd;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, maxEvents);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local-timezone day key (YYYY-MM-DD) for an ISO timestamp. */
export function localDayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDayKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** Group selected events by local day with display labels. Pure — shared with tests. */
export function buildGroups(events, now) {
  const todayKey = localDayKey(now.toISOString());
  const tomorrowKey = shiftDayKey(todayKey, 1);
  const groups = [];
  let current = null;

  for (const ev of events ?? []) {
    const key = localDayKey(ev.start);
    if (!current || current.key !== key) {
      let label;
      if (key === todayKey) label = 'Today';
      else if (key === tomorrowKey) label = 'Tomorrow';
      else {
        const [y, m, d] = key.split('-').map(Number);
        label = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(
          new Date(y, m - 1, d, 12),
        );
      }
      current = { key, label, items: [] };
      groups.push(current);
    }
    current.items.push(ev);
  }
  return groups;
}

function timeLabel(ev) {
  if (ev.allDay) return 'All day';
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}

function relativeTime(ts) {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function initCalendar(cfg) {
  const panel = document.getElementById('calendar');
  const listEl = document.getElementById('events');
  if (!panel || !listEl) return;

  function render(events, updatedAt, stale) {
    const maxEvents = Number(cfg?.calendar?.maxEvents) || 6;
    const selected = selectEvents(events, new Date(), { maxEvents });
    if (selected.length === 0) {
      panel.hidden = true; // nothing to show: stay out of the way entirely
      return;
    }
    panel.hidden = false;

    listEl.replaceChildren();
    for (const group of buildGroups(selected, new Date())) {
      const head = document.createElement('li');
      head.className = 'ev-group';
      head.textContent = group.label;
      listEl.appendChild(head);
      for (const ev of group.items) {
        const row = document.createElement('li');
        const time = document.createElement('span');
        time.className = 'ev-time';
        time.textContent = timeLabel(ev);
        const title = document.createElement('span');
        title.className = 'ev-title';
        title.textContent = ev.title;
        row.append(time, title);
        listEl.appendChild(row);
      }
    }

    const note = document.getElementById('cal-stale');
    if (note) {
      if (stale && updatedAt) {
        note.hidden = false;
        note.textContent = `updated ${relativeTime(updatedAt)}`;
      } else {
        note.hidden = true;
      }
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/calendar');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error || !Array.isArray(body.events)) {
        panel.hidden = true; // never fetched successfully: hide quietly
        return;
      }
      render(body.events, body.updatedAt, Boolean(body.stale));
    } catch (err) {
      console.warn('[calendar] refresh failed:', err.message);
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
}
