import http from 'node:http';
import { createReadStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { DiskCache } from './cache.js';
import { scanPhotos, resolvePhotoPath, servePhotoFile } from './photos.js';
import { fetchWeather } from './weather/provider.js';
import { fetchCalendar } from './calendar/ics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CONFIG_PATH = process.env.HOMEDASHBOARD_CONFIG ?? path.join(__dirname, '..', 'config.json');

const config = new ConfigStore(CONFIG_PATH);
config.start();

// Photo list is re-scanned at most every 30s so newly added photos appear
// without hammering the disk on each request.
let photoListCache = { dir: null, at: 0, list: [] };
async function getPhotoList() {
  const cfg = config.get();
  const dir = path.resolve(process.cwd(), cfg.photoDirectory);
  if (photoListCache.dir === dir && Date.now() - photoListCache.at < 30_000) {
    return photoListCache.list;
  }
  let list = [];
  try {
    list = await scanPhotos(dir);
  } catch (err) {
    console.warn('[photos] scan failed:', err.message);
  }
  photoListCache = { dir, at: Date.now(), list };
  return list;
}

// Weather: in-memory result is fresh for WEATHER_TTL_MS; the disk cache holds
// the last successful response across restarts and outages. Concurrent
// requests share one in-flight fetch (single-flight).
const WEATHER_TTL_MS = 10 * 60_000;
const weatherDiskCache = new DiskCache(path.join(__dirname, '..', 'cache'), 'weather');
let weatherMem = null; // { data, updatedAt }
let weatherInFlight = null;

async function getWeather() {
  const cfg = config.get().weather;
  if (weatherMem && Date.now() - weatherMem.updatedAt < WEATHER_TTL_MS) {
    return { ...weatherMem, stale: false };
  }
  try {
    if (!weatherInFlight) {
      weatherInFlight = fetchWeather(cfg).finally(() => {
        weatherInFlight = null;
      });
    }
    const data = await weatherInFlight;
    weatherMem = { data, updatedAt: Date.now() };
    try {
      weatherDiskCache.save(data);
    } catch (err) {
      console.warn('[weather] cache save failed:', err.message);
    }
    return { ...weatherMem, stale: false };
  } catch (err) {
    console.warn('[weather] fetch failed:', err.message);
    const fallback = weatherMem ?? weatherDiskCache.load();
    if (fallback) return { data: fallback.data, updatedAt: fallback.savedAt ?? fallback.updatedAt, stale: true };
    throw err;
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8',
};

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.replace(/^\/+/, ''));
  if (rel === '') rel = 'index.html';
  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  const stream = createReadStream(full);
  // A read error mid-stream (file removed/replaced between stat and read) must
  // not become an uncaught exception that kills the process.
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// Calendar: same pattern as weather — in-memory result gated by the
// configured refresh interval, disk cache for restarts/outages, single-flight.
const calendarDiskCache = new DiskCache(path.join(__dirname, '..', 'cache'), 'calendar');
let calendarMem = null; // { events, updatedAt }
let calendarInFlight = null;

async function getCalendar() {
  const cfg = config.get().calendar;
  if (!cfg.feedUrl) throw new Error('calendar feed not configured');
  const ttlMs = Math.max(1, Number(cfg.refreshMinutes) || 15) * 60_000;
  if (calendarMem && Date.now() - calendarMem.updatedAt < ttlMs) {
    return { ...calendarMem, stale: false };
  }
  try {
    if (!calendarInFlight) {
      calendarInFlight = fetchCalendar(cfg).finally(() => {
        calendarInFlight = null;
      });
    }
    const events = await calendarInFlight;
    calendarMem = { events, updatedAt: Date.now() };
    try {
      calendarDiskCache.save(events);
    } catch (err) {
      console.warn('[calendar] cache save failed:', err.message);
    }
    return { ...calendarMem, stale: false };
  } catch (err) {
    console.warn('[calendar] fetch failed:', err.message);
    const fallback = calendarMem ?? calendarDiskCache.load();
    if (fallback) return { events: fallback.data, updatedAt: fallback.savedAt, stale: true };
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/config') return sendJson(res, 200, config.get());
    if (url.pathname === '/api/photos') {
      const list = await getPhotoList();
      return sendJson(res, 200, { photos: list });
    }
    if (url.pathname === '/api/weather') {
      try {
        const result = await getWeather();
        return sendJson(res, 200, result);
      } catch (err) {
        // No live data and no cache at all: report unavailability so the UI
        // can hide the panel quietly. Never a 5xx — weather is best-effort.
        return sendJson(res, 200, { error: err.message ?? 'weather unavailable' });
      }
    }
    if (url.pathname === '/api/calendar') {
      try {
        const result = await getCalendar();
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 200, { error: err.message ?? 'calendar unavailable' });
      }
    }
    if (url.pathname.startsWith('/photos/')) {
      const rel = decodeURIComponent(url.pathname.slice('/photos/'.length));
      const baseDir = path.resolve(process.cwd(), config.get().photoDirectory);
      const full = resolvePhotoPath(baseDir, rel);
      if (!full) return sendJson(res, 403, { error: 'forbidden' });
      return await servePhotoFile(res, full);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error('[server] request error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  }
});

// Appliance policy: a bug should restart the service cleanly (systemd brings it
// back in seconds and the browser keeps showing already-rendered content),
// never hang as a zombie.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception — exiting for clean restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection — exiting for clean restart:', err);
  process.exit(1);
});

const port = config.get().port;
// Loopback only: the display is local and nothing here should be exposed.
server.listen(port, '127.0.0.1', () => {
  console.log(`[server] HomeDashboard listening on http://127.0.0.1:${port}`);
});
