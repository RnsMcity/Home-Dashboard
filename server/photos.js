import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';

export const SUPPORTED_EXTENSIONS = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

/**
 * List supported image files in a directory (top level only, sorted).
 * A missing/unreadable directory yields [] so the slideshow keeps its last
 * known list instead of erroring.
 */
export async function scanPhotos(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(entry.name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve a relative photo path inside baseDir. Returns null when the result
 * would escape the directory (path traversal guard).
 */
export function resolvePhotoPath(baseDir, rel) {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** Stream a photo file to the response with the right content type. */
export async function servePhotoFile(res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const type = SUPPORTED_EXTENSIONS.get(path.extname(filePath).toLowerCase());
  if (!type) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported format' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
