import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

/**
 * The migration ladder.
 *
 * `PRAGMA user_version` is the cursor and this array is the ladder: index 0 is
 * migration 1. **Steps are append-only and are never edited once released** — a step that
 * changes under a database that already ran it is a schema that differs per developer,
 * which is the one failure a migration system exists to prevent.
 */
const STEPS: Array<{ name: string; sql: string }> = [
  { name: '001-initial', sql: readSchema('schema.sql') },
  { name: '002-api-keys', sql: readSchema('002-api-keys.sql') },
  { name: '003-subaccounts', sql: readSchema('003-subaccounts.sql') },
];

function readSchema(file: string): string {
  // Resolved against this module rather than the working directory, so `tsx src/…` and
  // `node dist/…` both find it — `dist/` mirrors `src/`, and the .sql is copied beside it.
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
}

export interface OpenOptions {
  path: string;
  /** Where recordings are written. Created here so nothing downstream has to check. */
  recordingsDir?: string;
}

/**
 * Open the database and bring it up to date.
 *
 * Pragmas, in the order they matter:
 * - **WAL**, so a read (the UI polling history) never blocks a write (a call in progress).
 *   Skipped for `:memory:`, which has no journal to move.
 * - **`foreign_keys = ON`**, which SQLite leaves *off* by default — the `REFERENCES`
 *   clauses in the schema are decoration until this is set, and a dangling `call_sid`
 *   would be accepted silently.
 * - **`busy_timeout`**, because better-sqlite3 is synchronous and a lock contended by the
 *   WAL checkpointer should wait rather than throw `SQLITE_BUSY` into a live call.
 */
export function openDb(options: OpenOptions): Db {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  if (options.recordingsDir) {
    mkdirSync(options.recordingsDir, { recursive: true });
  }

  const db = new Database(options.path);
  if (options.path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Apply every step the database has not seen. Idempotent; safe to call on every boot. */
export function migrate(db: Db): void {
  const current = Number((db.pragma('user_version', { simple: true }) as number) ?? 0);
  for (let version = current; version < STEPS.length; version += 1) {
    const step = STEPS[version];
    if (!step) continue;
    // One transaction per step, with the version bump inside it: a step that fails
    // half-way must not leave a database claiming to have run it.
    db.exec('BEGIN');
    try {
      db.exec(step.sql);
      db.pragma(`user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${step.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
}

/** Seconds since the epoch. Every `*_at` and `*_time` column in the schema is one of these. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}
