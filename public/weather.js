// Weather panel. Polls /api/weather (the server gates actual API calls with a
// TTL and serves its last successful response when the provider is down). A
// failure here never touches the rest of the dashboard — worst case the panel
// stays hidden or keeps showing stale data with a subtle note.

const POLL_MS = 3 * 60_000;

function relativeTime(ts) {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function weekdayShort(dayIso) {
  // Noon avoids timezone edge cases when parsing a bare date.
  const d = new Date(`${dayIso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
}

export function initWeather(cfg) {
  const panel = document.getElementById('weather');
  if (!panel) return;

  function render(data, updatedAt, stale) {
    panel.hidden = false;
    document.getElementById('w-temp').textContent = `${Math.round(data.temperature)}°`;
    document.getElementById('w-condition').textContent = data.condition ?? '';
    const icon = document.getElementById('w-icon');
    if (data.iconKey) icon.src = `/icons/${data.iconKey}.svg`;

    const hilow = document.getElementById('w-hilow');
    if (Number.isFinite(data.high) && Number.isFinite(data.low)) {
      hilow.textContent = `H ${Math.round(data.high)}°  L ${Math.round(data.low)}°`;
    } else {
      hilow.textContent = '';
    }

    const strip = document.getElementById('w-forecast');
    strip.replaceChildren();
    for (const day of data.forecast ?? []) {
      if (!Number.isFinite(day.high) || !Number.isFinite(day.low)) continue;
      const col = document.createElement('div');
      col.className = 'fday';
      const name = document.createElement('span');
      name.className = 'f-name';
      name.textContent = weekdayShort(day.day);
      const img = document.createElement('img');
      img.src = `/icons/${day.iconKey}.svg`;
      img.alt = '';
      const temps = document.createElement('span');
      temps.className = 'f-temps';
      temps.textContent = `${Math.round(day.high)}° ${Math.round(day.low)}°`;
      col.append(name, img, temps);
      strip.appendChild(col);
    }

    const note = document.getElementById('w-stale');
    if (stale && updatedAt) {
      note.hidden = false;
      note.textContent = `updated ${relativeTime(updatedAt)}`;
    } else {
      note.hidden = true;
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/weather');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error || !body.data) {
        panel.hidden = true; // nothing ever fetched: stay out of the way
        return;
      }
      render(body.data, body.updatedAt, Boolean(body.stale));
    } catch (err) {
      console.warn('[weather] refresh failed:', err.message);
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
}
