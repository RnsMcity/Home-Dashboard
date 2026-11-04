import { readFileSync, statSync } from 'node:fs';

export const DEFAULTS = Object.freeze({
  port: 8787,
  photoDirectory: './photos',
  photoIntervalSeconds: 300,
  weather: { provider: 'openweathermap', latitude: null, longitude: null, units: 'imperial' },
  calendar: { feedUrl: '', refreshMinutes: 15, maxEvents: 6 },
  // Per-side margins default to null (= unset); when set they override marginPx.
  display: {
    theme: 'dark',
    hour12: false,
    marginPx: 0,
    marginTopPx: null,
    marginLeftPx: null,
    marginRightPx: null,
    marginBottomPx: null,
  },
});

export class ConfigError extends Error {}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Merge plain objects recursively; override wins leaf-by-leaf. */
export function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Returns a list of human-readable problems (empty when valid). */
export function validateConfig(cfg) {
  const errors = [];

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push('port must be an integer between 1 and 65535');
  }
  if (typeof cfg.photoDirectory !== 'string' || !cfg.photoDirectory.trim()) {
    errors.push('photoDirectory must be a non-empty string');
  }
  if (!Number.isFinite(cfg.photoIntervalSeconds) || cfg.photoIntervalSeconds < 5) {
    errors.push('photoIntervalSeconds must be a number >= 5');
  }

  const w = cfg.weather;
  if (!isPlainObject(w)) {
    errors.push('weather must be an object');
  } else {
    if (typeof w.provider !== 'string' || !w.provider.trim()) {
      errors.push('weather.provider must be a non-empty string');
    }
    for (const key of ['latitude', 'longitude']) {
      if (w[key] !== null && !Number.isFinite(w[key])) {
        errors.push(`weather.${key} must be a number or null`);
      }
    }
    if (w.latitude !== null && (w.latitude < -90 || w.latitude > 90)) {
      errors.push('weather.latitude out of range (-90..90)');
    }
    if (w.longitude !== null && (w.longitude < -180 || w.longitude > 180)) {
      errors.push('weather.longitude out of range (-180..180)');
    }
    if (!['metric', 'imperial'].includes(w.units)) {
      errors.push("weather.units must be 'metric' or 'imperial'");
    }
  }

  const c = cfg.calendar;
  if (!isPlainObject(c)) {
    errors.push('calendar must be an object');
  } else {
    if (typeof c.feedUrl !== 'string') {
      errors.push('calendar.feedUrl must be a string (empty disables the calendar)');
    } else if (c.feedUrl && !/^https?:\/\//.test(c.feedUrl)) {
      errors.push('calendar.feedUrl must start with http:// or https://');
    }
    if (!Number.isFinite(c.refreshMinutes) || c.refreshMinutes < 1) {
      errors.push('calendar.refreshMinutes must be a number >= 1');
    }
    if (!Number.isInteger(c.maxEvents) || c.maxEvents < 1 || c.maxEvents > 20) {
      errors.push('calendar.maxEvents must be an integer between 1 and 20');
    }
  }

  const d = cfg.display;
  if (!isPlainObject(d)) {
    errors.push('display must be an object');
  } else {
    if (d.theme !== undefined && !['dark', 'light'].includes(d.theme)) {
      errors.push("display.theme must be 'dark' or 'light'");
    }
    if (d.hour12 !== undefined && typeof d.hour12 !== 'boolean') {
      errors.push('display.hour12 must be true or false');
    }
    if (d.marginPx !== undefined && (!Number.isInteger(d.marginPx) || d.marginPx < 0)) {
      errors.push('display.marginPx must be a non-negative integer (pixels)');
    }
    for (const key of ['marginTopPx', 'marginLeftPx', 'marginRightPx', 'marginBottomPx']) {
      if (d[key] !== null && (!Number.isInteger(d[key]) || d[key] < 0)) {
        errors.push(`display.${key} must be a non-negative integer (pixels) or null`);
      }
    }
  }

  return errors;
}

/** Read + merge + validate. Throws ConfigError on unreadable/invalid file. */
export function loadConfigFile(filePath) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new ConfigError(`cannot read ${filePath}: ${err.message}`);
  }
  const merged = deepMerge(DEFAULTS, raw);
  const errors = validateConfig(merged);
  if (errors.length > 0) throw new ConfigError(`invalid config: ${errors.join('; ')}`);
  return merged;
}

/**
 * Holds the current valid configuration and polls the file for changes.
 * An invalid edit never takes effect: the previous good config is kept and
 * the problem is logged, so a typo can't take the appliance down.
 */
export class ConfigStore {
  constructor(filePath, { pollMs = 30_000 } = {}) {
    this.filePath = filePath;
    this.pollMs = pollMs;
    this._timer = null;
    this._mtime = null;
    this.config = this.#read();
  }

  #read() {
    try {
      return loadConfigFile(this.filePath);
    } catch (err) {
      console.error(`[config] ${err.message} — using defaults`);
      return structuredClone(DEFAULTS);
    }
  }

  get() {
    return this.config;
  }

  start() {
    if (!this.pollMs || this._timer) return;
    this._timer = setInterval(() => this.#poll(), this.pollMs);
    this._timer.unref?.();
  }

  #poll() {
    let st;
    try {
      st = statSync(this.filePath);
    } catch {
      return; // file absent: keep current config, retry next tick
    }
    if (this._mtime !== null && st.mtimeMs === this._mtime) return;
    this._mtime = st.mtimeMs;
    try {
      this.config = loadConfigFile(this.filePath);
      console.log('[config] reloaded');
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`[config] ${err.message} — keeping previous config`);
      } else {
        throw err;
      }
    }
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}
