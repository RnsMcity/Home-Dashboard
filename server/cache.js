import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Tiny disk-backed cache for "last successful response" data.
 * Each key is one JSON file; writes are atomic (tmp + rename) so a crash
 * mid-write can never corrupt the cached payload.
 */
export class DiskCache {
  constructor(dir, key) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${key}.json`);
  }

  /** @returns {{data: any, savedAt: number} | null} */
  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.savedAt === 'number') {
        return { data: parsed.data, savedAt: parsed.savedAt };
      }
    } catch {
      // missing or corrupt file: treat as empty cache
    }
    return null;
  }

  save(data) {
    const payload = JSON.stringify({ data, savedAt: Date.now() });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, this.file);
  }
}
