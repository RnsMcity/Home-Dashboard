import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scanPhotos, resolvePhotoPath } from '../server/photos.js';

function makeDir() {
  return mkdtempSync(path.join(tmpdir(), 'hd-photos-'));
}

test('scanPhotos finds supported files and ignores the rest', async () => {
  const dir = makeDir();
  try {
    writeFileSync(path.join(dir, 'a.jpg'), 'x');
    writeFileSync(path.join(dir, 'b.PNG'), 'x'); // extension case-insensitive
    writeFileSync(path.join(dir, 'c.webp'), 'x');
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    writeFileSync(path.join(dir, 'd.heic'), 'x'); // not decodable in Chrome: excluded
    mkdirSync(path.join(dir, 'subdir'));
    assert.deepEqual(await scanPhotos(dir), ['a.jpg', 'b.PNG', 'c.webp']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanPhotos returns [] for a missing directory', async () => {
  assert.deepEqual(await scanPhotos(path.join(tmpdir(), `nope-${Date.now()}`)), []);
});

test('scanPhotos returns [] for an empty directory', async () => {
  const dir = makeDir();
  try {
    assert.deepEqual(await scanPhotos(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePhotoPath keeps paths inside the base directory', () => {
  const base = '/home/pi/photos';
  assert.equal(resolvePhotoPath(base, 'a.jpg'), path.join(base, 'a.jpg'));
  assert.equal(resolvePhotoPath(base, './sub/../b.png'), path.join(base, 'b.png'));
});

test('resolvePhotoPath rejects traversal and absolute escapes', () => {
  const base = '/home/pi/photos';
  assert.equal(resolvePhotoPath(base, '../etc/passwd'), null);
  assert.equal(resolvePhotoPath(base, '../../root/.ssh/id_rsa'), null);
  assert.equal(resolvePhotoPath(base, '/etc/passwd'), null);
});
