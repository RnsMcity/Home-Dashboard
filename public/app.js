import { initClock } from './clock.js';
import { initSlideshow } from './photos.js';
import { initWeather } from './weather.js';
import { initCalendar } from './calendar.js';

// Each panel is independent: one failing module must never take down the rest.
function safeStart(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[dashboard] ${name} failed to start:`, err);
  }
}

async function main() {
  let cfg = {};
  try {
    const res = await fetch('/api/config');
    if (res.ok) cfg = await res.json();
  } catch (err) {
    console.warn('[dashboard] config unavailable, using defaults:', err.message);
  }
  document.body.dataset.theme = cfg.display?.theme ?? 'dark';

  safeStart('clock', initClock);
  safeStart('slideshow', () => initSlideshow(cfg));
  safeStart('weather', () => initWeather(cfg));
  safeStart('calendar', () => initCalendar(cfg));
}

window.addEventListener('error', (e) => {
  console.error('[dashboard] uncaught error:', e.message);
});

main().catch((err) => console.error('[dashboard] bootstrap failed:', err));
