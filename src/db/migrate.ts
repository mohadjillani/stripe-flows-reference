import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Pool } from './pool.ts';

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('migrations/001_init.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

/** True when this module is the file Node was started with. */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // Resolved paths rather than a URL comparison: a path containing a space
  // comes back percent-encoded and the comparison silently fails.
  return fileURLToPath(moduleUrl) === path.resolve(entry);
}

if (isMainModule(import.meta.url)) {
  const pool = createPool();
  try {
    await migrate(pool);
    console.log('migrated');
  } finally {
    await pool.end();
  }
}
