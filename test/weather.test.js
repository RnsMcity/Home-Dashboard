import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWeather, WeatherError } from '../server/weather/provider.js';
import { mapOwmIcon } from '../server/weather/openweathermap.js';
import { mapWmoIcon } from '../server/weather/open-meteo.js';

test('mapOwmIcon covers the OWM icon set', () => {
  // OWM has no "00": clear sky is 01.
  assert.equal(mapOwmIcon('01d'), 'clear-day');
  assert.equal(mapOwmIcon('01n'), 'clear-night');
  assert.equal(mapOwmIcon('02d'), 'partly-cloudy-day'); // few clouds
  assert.equal(mapOwmIcon('03n'), 'partly-cloudy-night'); // scattered clouds
  assert.equal(mapOwmIcon('04d'), 'cloudy'); // broken/overcast
  assert.equal(mapOwmIcon('50d'), 'fog');
  assert.equal(mapOwmIcon('51d'), 'drizzle');
  assert.equal(mapOwmIcon('61d'), 'rain');
  assert.equal(mapOwmIcon('82n'), 'rain'); // showers
  assert.equal(mapOwmIcon('71n'), 'snow');
  assert.equal(mapOwmIcon('90d'), 'thunderstorm');
});

test('mapWmoIcon covers WMO code families', () => {
  assert.equal(mapWmoIcon(0, true), 'clear-day');
  assert.equal(mapWmoIcon(0, false), 'clear-night');
  assert.equal(mapWmoIcon(2, true), 'partly-cloudy-day');
  assert.equal(mapWmoIcon(3, true), 'cloudy');
  assert.equal(mapWmoIcon(45, true), 'fog');
  assert.equal(mapWmoIcon(55, true), 'drizzle');
  assert.equal(mapWmoIcon(63, true), 'rain');
  assert.equal(mapWmoIcon(71, true), 'snow');
  assert.equal(mapWmoIcon(95, true), 'thunderstorm');
});

test('fetchWeather rejects unknown providers and missing location', async () => {
  await assert.rejects(
    fetchWeather({ provider: 'nope', latitude: 1, longitude: 2 }),
    (err) => err instanceof WeatherError && /unknown weather provider/.test(err.message),
  );
  await assert.rejects(
    fetchWeather({ provider: 'openweathermap', latitude: null, longitude: null }, {}),
    (err) => err instanceof WeatherError && /location not configured/.test(err.message),
  );
});

// --- OpenWeatherMap normalization with a mocked fetch -----------------------

function owmForecastList() {
  // 40 entries: 5 days x 8, temps shaped so each day has distinct hi/lo.
  const list = [];
  for (let d = 0; d < 5; d++) {
    for (let h = 0; h < 8; h++) {
      // sine-ish curve peaking mid-day
      const temp = 10 + d * 2 + Math.sin((h / 7) * Math.PI) * 6;
      list.push({
        dt: Date.UTC(2026, 8, 19 + d, h * 3) / 1000,
        temp: { main: Number(temp.toFixed(1)) },
        weather: [{ icon: h === 4 ? '01d' : '02d', description: 'scattered clouds' }],
      });
    }
  }
  return list;
}

function mockOwmFetch() {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/weather?')) {
      return {
        ok: true,
        json: async () => ({
          main: { temp: 19.4, feels_like: 18.9 },
          weather: [{ description: 'scattered clouds', icon: '03d' }],
        }),
      };
    }
    if (String(url).includes('/forecast?')) {
      return { ok: true, json: async () => ({ list: owmForecastList() }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return calls;
}

test('openweathermap provider normalizes current + daily hi/lo + forecast', async () => {
  const calls = mockOwmFetch();
  try {
    const data = await fetchWeather(
      { provider: 'openweathermap', latitude: 47.6, longitude: -122.3, units: 'metric' },
      { OPENWEATHERMAP_API_KEY: 'test-key' },
    );
    assert.equal(data.temperature, 19.4);
    assert.equal(data.feelsLike, 18.9);
    assert.equal(data.condition, 'Scattered clouds'); // capitalized
    assert.equal(data.iconKey, 'partly-cloudy-day'); // 03d -> scattered clouds
    assert.ok(Number.isFinite(data.high) && Number.isFinite(data.low));
    assert.ok(data.high > data.low);
    assert.equal(data.forecast.length, 3);
    for (const day of data.forecast) {
      assert.match(day.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isFinite(day.high) && Number.isFinite(day.low));
      assert.ok(typeof day.iconKey === 'string' && day.iconKey.length > 0);
    }
    // both endpoints hit with the key and units
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.ok(c.includes('appid=test-key'));
      assert.ok(c.includes('units=metric'));
    }
  } finally {
    delete globalThis.fetch;
  }
});

test('openweathermap provider fails cleanly without an API key', async () => {
  await assert.rejects(
    fetchWeather({ provider: 'openweathermap', latitude: 1, longitude: 2 }, {}),
    (err) => err instanceof WeatherError && /API_KEY/.test(err.message),
  );
});

test('openweathermap provider surfaces network failures as WeatherError', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    await assert.rejects(
      fetchWeather({ provider: 'openweathermap', latitude: 1, longitude: 2 }, { OPENWEATHERMAP_API_KEY: 'k' }),
      (err) => err instanceof WeatherError && /network error/.test(err.message),
    );
  } finally {
    delete globalThis.fetch;
  }
});

// --- Open-Meteo normalization with a mocked fetch ---------------------------

function mockMeteoFetch() {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('api.open-meteo.com'));
    return {
      ok: true,
      json: async () => ({
        current: { time: '2026-09-18T14:30', temperature_2m: 21.5, apparent_temperature: 20.8, weather_code: 2 },
        daily: {
          time: ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21'],
          temperature_2m_max: [24, 25, 23, 22],
          temperature_2m_min: [12, 13, 11, 10],
          weather_code: [2, 61, 71, 95],
          sunrise: ['2026-09-18T06:54', '2026-09-19T06:55'],
          sunset: ['2026-09-18T19:37', '2026-09-19T19:36'],
        },
      }),
    };
  };
}

test('open-meteo provider normalizes and picks day/night from sunrise/sunset', async () => {
  mockMeteoFetch();
  try {
    const data = await fetchWeather(
      { provider: 'open-meteo', latitude: 47.6, longitude: -122.3, units: 'imperial' },
      {},
    );
    assert.equal(data.temperature, 21.5);
    assert.equal(data.condition, 'Partly cloudy');
    assert.equal(data.iconKey, 'partly-cloudy-day'); // 14:30 is between sunrise and sunset
    assert.equal(data.high, 24);
    assert.equal(data.low, 12);
    assert.deepEqual(
      data.forecast.map((d) => d.day),
      ['2026-09-19', '2026-09-20', '2026-09-21'],
    );
    assert.equal(data.forecast[0].iconKey, 'rain'); // WMO 61
    assert.equal(data.forecast[1].iconKey, 'snow'); // WMO 71
    assert.equal(data.forecast[2].iconKey, 'thunderstorm'); // WMO 95
  } finally {
    delete globalThis.fetch;
  }
});
