import { WeatherError } from './provider.js';

const BASE = 'https://api.openweathermap.org/data/2.5';

/**
 * Map an OWM icon code like "01d"/"71n" to a local icon key.
 * OWM's set has no "00": clear sky is 01, clouds are 02-04, fog 50,
 * drizzle 51-57, rain 60-67, snow 70-77, showers 80-82, storms 90-92.
 */
export function mapOwmIcon(code) {
  const s = String(code ?? '');
  const night = s.endsWith('n');
  switch (s.slice(0, 2)) {
    case '00': // defensive: not in OWM's set
    case '01':
      return night ? 'clear-night' : 'clear-day';
    case '02':
    case '03':
      return night ? 'partly-cloudy-night' : 'partly-cloudy-day';
    case '04':
      return 'cloudy';
    case '50':
      return 'fog';
    case '51':
    case '52':
    case '53':
    case '55':
    case '56':
    case '57':
      return 'drizzle';
    case '60':
    case '61':
    case '62':
    case '63':
    case '64':
    case '65':
    case '66':
    case '67':
    case '80': // showers
    case '81':
    case '82':
      return 'rain';
    case '70':
    case '71':
    case '72':
    case '73':
    case '74':
    case '75':
    case '76':
    case '77':
      return 'snow';
    default:
      return 'thunderstorm'; // 90-92
  }
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new WeatherError(`network error: ${err.message}`);
  }
  if (!res.ok) throw new WeatherError(`HTTP ${res.status} from weather provider`);
  try {
    return await res.json();
  } catch {
    throw new WeatherError('invalid JSON response from weather provider');
  }
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/**
 * OpenWeatherMap (free tier). Two parallel calls: current conditions and the
 * 5-day forecast. The /forecast endpoint returns 40 entries (5 days x 8) in
 * local-day order, so daily hi/lo are derived by grouping consecutive eights.
 */
export async function fetchOpenWeatherMap(cfg, env) {
  const key = env.OPENWEATHERMAP_API_KEY;
  if (!key) throw new WeatherError('OPENWEATHERMAP_API_KEY is not set');

  const units = cfg.units === 'imperial' ? 'imperial' : 'metric';
  const params = `lat=${cfg.latitude}&lon=${cfg.longitude}&units=${units}&appid=${encodeURIComponent(key)}`;

  const [current, forecast] = await Promise.all([
    getJson(`${BASE}/weather?${params}`),
    getJson(`${BASE}/forecast?${params}`),
  ]);

  if (!current?.main || !Array.isArray(current.weather)) {
    throw new WeatherError('unexpected current-weather response');
  }

  const temperature = Number(current.main.temp);
  const feelsLike = current.main.feels_like != null ? Number(current.main.feels_like) : null;
  const condition = capitalize(current.weather[0]?.description ?? '');
  const iconKey = mapOwmIcon(current.weather[0]?.icon);

  let high = null;
  let low = null;
  const forecastDays = [];
  if (Array.isArray(forecast?.list)) {
    const days = Math.min(5, Math.floor(forecast.list.length / 8));
    for (let d = 0; d < days; d++) {
      const group = forecast.list.slice(d * 8, d * 8 + 8);
      if (!group.length) continue;
      const temps = group.map((e) => Number(e?.temp?.main)).filter(Number.isFinite);
      if (!temps.length) continue;
      const dayHigh = Math.max(...temps);
      const dayLow = Math.min(...temps);
      const noon = group[4] ?? group[Math.floor(group.length / 2)];
      const iconKeyDay = mapOwmIcon(noon?.weather?.[0]?.icon);
      const day = new Date(Number(group[0].dt) * 1000).toISOString().slice(0, 10);
      if (d === 0) {
        high = dayHigh;
        low = dayLow;
      } else {
        forecastDays.push({ day, high: dayHigh, low: dayLow, iconKey: iconKeyDay });
      }
    }
  }

  return { temperature, feelsLike, condition, iconKey, high, low, forecast: forecastDays.slice(0, 3) };
}
