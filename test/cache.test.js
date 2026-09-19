import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DiskCache } from '../server/cache.js';

test('DiskCache round-trips data with a timestamp', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cache-'));
  try {
    const cache = new DiskCache(dir, 'weather');
    assert.equal(cache.load(), null);
    cache.save({ temp: 21 });
    const hit = cache.load();
    assert.deepEqual(hit.data, { temp: 21 });
    assert.ok(typeof hit.savedAt === 'number' && hit.savedAt > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCache treats corrupt files as empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cache-'));
  try {
    const cache = new DiskCache(dir, 'calendar');
    writeFileSync(cache.file, '{ broken json !!');
    assert.equal(cache.load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCache save is atomic (no leftover tmp files)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-cache-'));
  try {
    const cache = new DiskCache(dir, 'weather');
    cache.save({ a: 1 });
    cache.save({ a: 2 });
    const entries = readdirSync(dir);
    assert.deepEqual(entries.sort(), ['weather.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
