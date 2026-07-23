import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// One stable, repository-specific 64-bit advisory-lock key. A session lock
// covers the migrations-table check and every pending migration, preventing
// two release jobs from both selecting and applying the same file.
const MIGRATION_LOCK_KEY = '5065534519711111796';

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Applies every `*.sql` file in `migrations/` not yet recorded in
 * `schema_migrations`, in lexicographic filename order, each inside its own
 * transaction. Deterministic and safe to re-run. */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    lockAcquired = true;
    await ensureMigrationsTable(client);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM schema_migrations WHERE id = $1',
        [file],
      );
      if (rows.length > 0) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
    return applied;
  } finally {
    if (lockAcquired) {
      await client
        .query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY])
        .catch(() => {});
    }
    client.release();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new pg.Pool({ connectionString });
  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log('no pending migrations');
    } else {
      console.log(`applied: ${applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

/** `pnpm deploy`'s production layout puts this package under
 * `node_modules/.pnpm/...` and symlinks it into `node_modules/@fuse/...`, so
 * the path the CLI is invoked with (`process.argv[1]`, unresolved) never
 * string-equals `import.meta.url`'s realpath — a naive comparison makes
 * `main()` silently never run, so migrations silently never apply. Resolving
 * both sides through the filesystem (not just `import.meta.url`'s target)
 * makes the check symlink-proof. */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  let resolvedArgv1: string;
  try {
    resolvedArgv1 = realpathSync(argv1);
  } catch {
    return false;
  }
  return resolvedArgv1 === fileURLToPath(moduleUrl);
}

const isMain = isMainModule(process.argv[1], import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
