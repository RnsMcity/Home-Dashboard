import { WeatherError } from './provider.js';

const WMO_CONDITIONS = new Map([
  [0, 'Clear sky'],
  [1, 'Mainly clear'],
  [2, 'Partly cloudy'],
  [3, 'Overcast'],
  [45, 'Fog'],
  [48, 'Rime fog'],
  [51, 'Light drizzle'],
  [53, 'Drizzle'],
  [55, 'Dense drizzle'],
  [56, 'Freezing drizzle'],
  [57, 'Freezing drizzle'],
  [61, 'Light rain'],
  [63, 'Rain'],
  [65, 'Heavy rain'],
  [66, 'Freezing rain'],
  [67, 'Freezing rain'],
  [71, 'Light snow'],
  [73, 'Snow'],
  [75, 'Heavy snow'],
  [77, 'Snow grains'],
  [80, 'Light showers'],
  [81, 'Showers'],
  [82, 'Violent showers'],
  [85, 'Snow showers'],
  [86, 'Snow showers'],
  [95, 'Thunderstorm'],
  [96, 'Thunderstorm with hail'],
  [99, 'Thunderstorm with hail'],
]);

/** Map a WMO weather code to a local icon key. */
export function mapWmoIcon(code, isDay) {
  switch (code) {
    case 0:
      return isDay ? 'clear-day' : 'clear-night';
    case 1:
    case 2:
      return isDay ? 'partly-cloudy-day' : 'partly-cloudy-night';
    case 3:
      return 'cloudy';
    case 45:
    case 48:
      return 'fog';
    case 51:
    case 53:
    case 55:
    case 56:
    case 57:
      return 'drizzle';
    case 71:
    case 73:
    case 75:
    case 77:
    case 85:
    case 86:
      return 'snow';
    case 95:
    case 96:
    case 99:
      return 'thunderstorm';
    default:
      return 'rain'; // 61-67, 80-82
  }
}

/**
 * Open-Meteo — keyless fallback provider. Single call for current + daily.
 */
export async function fetchOpenMeteo(cfg) {
  const unit = cfg.units === 'imperial' ? 'fahrenheit' : 'celsius';
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${cfg.latitude}&longitude=${cfg.longitude}` +
    `&current=temperature_2m,apparent_temperature,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset` +
    `&timezone=auto&forecast_days=5&temperature_unit=${unit}`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new WeatherError(`network error: ${err.message}`);
  }
  if (!res.ok) throw new WeatherError(`HTTP ${res.status} from weather provider`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new WeatherError('invalid JSON response from weather provider');
  }
  const cur = data?.current;
  const daily = data?.daily;
  if (!cur || !Array.isArray(daily?.time)) throw new WeatherError('unexpected open-meteo response');

  // Day/night from today's sunrise/sunset (all local ISO strings).
  let isDay = true;
  try {
    const t = String(cur.time).slice(11, 16);
    const sunrise = String(daily.sunrise?.[0] ?? '').slice(11, 16);
    const sunset = String(daily.sunset?.[0] ?? '').slice(11, 16);
    if (sunrise && sunset) isDay = t >= sunrise && t < sunset;
  } catch {
    // keep default
  }

  const code = Number(cur.weather_code);
  return {
    temperature: Number(cur.temperature_2m),
    feelsLike: cur.apparent_temperature != null ? Number(cur.apparent_temperature) : null,
    condition: WMO_CONDITIONS.get(code) ?? 'Unknown',
    iconKey: mapWmoIcon(code, isDay),
    high: Number(daily.temperature_2m_max?.[0]),
    low: Number(daily.temperature_2m_min?.[0]),
    forecast: daily.time.slice(1, 4).map((day, i) => ({
      day,
      high: Number(daily.temperature_2m_max[i + 1]),
      low: Number(daily.temperature_2m_min[i + 1]),
      iconKey: mapWmoIcon(Number(daily.weather_code[i + 1]), true),
    })),
  };
}
