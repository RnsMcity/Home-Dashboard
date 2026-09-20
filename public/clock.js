// Clock + date. Uses the system timezone (the browser's), so no network is
// ever required and it keeps working indefinitely offline.

export function initClock() {
  const timeEl = document.getElementById('time');
  const dateEl = document.getElementById('date');
  if (!timeEl || !dateEl) return;

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  function formatDate(now) {
    const parts = {};
    for (const p of dateFmt.formatToParts(now)) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    return `${parts.weekday} · ${parts.month} ${parts.day}`;
  }

  function tick() {
    const now = new Date();
    timeEl.textContent = timeFmt.format(now);
    dateEl.textContent = formatDate(now);
  }

  tick();
  setInterval(tick, 1000);
}
