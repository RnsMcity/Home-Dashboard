import { fetchOpenWeatherMap } from './openweathermap.js';
import { fetchOpenMeteo } from './open-meteo.js';

export class WeatherError extends Error {}

// Provider registry. Each provider takes (weatherCfg, env) and returns the
// normalized shape:
//   { temperature, feelsLike, condition, iconKey, high, low,
//     forecast: [{ day: 'YYYY-MM-DD', high, low, iconKey }] }
const PROVIDERS = {
  openweathermap: fetchOpenWeatherMap,
  'open-meteo': fetchOpenMeteo,
};

export function availableProviders() {
  return Object.keys(PROVIDERS);
}

/** Dispatch to the configured provider. Throws WeatherError on any failure. */
export async function fetchWeather(weatherCfg, env = process.env) {
  const fn = PROVIDERS[weatherCfg?.provider];
  if (!fn) throw new WeatherError(`unknown weather provider: ${weatherCfg?.provider}`);
  if (weatherCfg.latitude === null || weatherCfg.longitude === null) {
    throw new WeatherError('weather location not configured');
  }
  return fn(weatherCfg, env);
}
