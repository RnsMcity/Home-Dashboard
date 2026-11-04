import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULTS, deepMerge, validateConfig, loadConfigFile, ConfigStore, ConfigError } from '../server/config.js';

test('deepMerge merges nested objects and lets override win', () => {
  const out = deepMerge(DEFAULTS, { weather: { units: 'imperial' }, port: 9000 });
  assert.equal(out.port, 9000);
  assert.equal(out.weather.units, 'imperial');
  // untouched sibling survives
  assert.equal(out.weather.provider, DEFAULTS.weather.provider);
});

test('deepMerge does not mutate its inputs', () => {
  const base = { a: { b: 1 } };
  deepMerge(base, { a: { b: 2 } });
  assert.equal(base.a.b, 1);
});

test('validateConfig accepts the defaults', () => {
  assert.deepEqual(validateConfig(structuredClone(DEFAULTS)), []);
});

test('validateConfig rejects bad values with readable messages', () => {
  const cfg = structuredClone(DEFAULTS);
  cfg.port = 'nope';
  cfg.weather.units = 'furlongs';
  cfg.calendar.feedUrl = 'ftp://example.com/x.ics';
  cfg.weather.latitude = 91;
  cfg.calendar.maxEvents = 0;
  cfg.display.marginPx = -5;
  const errors = validateConfig(cfg);
  assert.ok(errors.some((e) => e.includes('port')));
  assert.ok(errors.some((e) => e.includes('weather.units')));
  assert.ok(errors.some((e) => e.includes('feedUrl')));
  assert.ok(errors.some((e) => e.includes('latitude')));
  assert.ok(errors.some((e) => e.includes('maxEvents')));
  assert.ok(errors.some((e) => e.includes('marginPx')));
});

test('validateConfig accepts display.marginPx values', () => {
  for (const marginPx of [0, 48, 200]) {
    const cfg = structuredClone(DEFAULTS);
    cfg.display.marginPx = marginPx;
    assert.deepEqual(validateConfig(cfg), [], `marginPx=${marginPx} should be valid`);
  }
  for (const bad of ['48', 1.5, null]) {
    const cfg = structuredClone(DEFAULTS);
    cfg.display.marginPx = bad;
    assert.ok(
      validateConfig(cfg).some((e) => e.includes('marginPx')),
      `marginPx=${JSON.stringify(bad)} should be rejected`,
    );
  }
});

test('validateConfig handles display.hour12', () => {
  for (const hour12 of [true, false]) {
    const cfg = structuredClone(DEFAULTS);
    cfg.display.hour12 = hour12;
    assert.deepEqual(validateConfig(cfg), [], `hour12=${hour12} should be valid`);
  }
  for (const bad of ['24', null, 1, 'false']) {
    const cfg = structuredClone(DEFAULTS);
    cfg.display.hour12 = bad;
    assert.ok(
      validateConfig(cfg).some((e) => e.includes('hour12')),
      `hour12=${JSON.stringify(bad)} should be rejected`,
    );
  }
});

test('validateConfig handles per-side display margins', () => {
  const cfg = structuredClone(DEFAULTS);
  cfg.display.marginTopPx = 40;
  cfg.display.marginBottomPx = 120; // other sides stay null (= use marginPx)
  assert.deepEqual(validateConfig(cfg), []);

  for (const key of ['marginTopPx', 'marginLeftPx', 'marginRightPx', 'marginBottomPx']) {
    const bad = structuredClone(DEFAULTS);
    bad.display[key] = -5;
    assert.ok(
      validateConfig(bad).some((e) => e.includes(key)),
      `${key}=-5 should be rejected`,
    );
  }
});

test('loadConfigFile returns defaults when file is absent', () => {
  const cfg = loadConfigFile(path.join(tmpdir(), `no-such-${Date.now()}.json`));
  assert.deepEqual(cfg, DEFAULTS);
});

test('loadConfigFile merges a partial file over defaults', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ photoIntervalSeconds: 120 }));
    const cfg = loadConfigFile(file);
    assert.equal(cfg.photoIntervalSeconds, 120);
    assert.equal(cfg.port, DEFAULTS.port);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfigFile throws ConfigError on invalid JSON values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ port: -5 }));
    assert.throws(() => loadConfigFile(file), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfigFile throws on malformed JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, '{ not json');
    assert.throws(() => loadConfigFile(file), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ConfigStore falls back to defaults when the file is invalid at startup', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ port: -1 }));
    const store = new ConfigStore(file);
    assert.equal(store.get().port, DEFAULTS.port);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ConfigStore picks up valid edits and ignores invalid ones', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ photoIntervalSeconds: 60 }));
    const store = new ConfigStore(file, { pollMs: 25 });
    store.start();
    assert.equal(store.get().photoIntervalSeconds, 60);

    // invalid edit must not take effect
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(file, JSON.stringify({ photoIntervalSeconds: -9 }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(store.get().photoIntervalSeconds, 60);

    // valid edit is picked up
    writeFileSync(file, JSON.stringify({ photoIntervalSeconds: 240 }));
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 25));
      ok = store.get().photoIntervalSeconds === 240;
    }
    assert.ok(ok, 'expected reloaded value 240');
    store.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
