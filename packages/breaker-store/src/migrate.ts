import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// One stable, repository-specific 64-bit advisory-lock key. A session lock
// covers the migrations-table check and every pending migration, preventing
// two release jobs from both selecting and applying the same file.
const MIGRATION_LOCK_KEY = '5065534519711111796';

export interface MigrationManifestEntry {
  id: string;
  checksum: string;
}

interface MigrationFile extends MigrationManifestEntry {
  sql: string;
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((id) => {
      const contents = readFileSync(join(migrationsDir, id));
      return {
        id,
        checksum: createHash('sha256').update(contents).digest('hex'),
        sql: contents.toString('utf8'),
      };
    });
}

/** Returns the exact migration IDs and content digests shipped with this build. */
export function getMigrationManifest(
  migrationsDir: string = MIGRATIONS_DIR,
): MigrationManifestEntry[] {
  return loadMigrationFiles(migrationsDir).map(({ id, checksum }) => ({ id, checksum }));
}

async function ensureMigrationsTable(
  client: pg.PoolClient,
  migrations: readonly MigrationManifestEntry[],
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(
    'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT',
  );

  const expected = new Map(
    migrations.map((migration) => [migration.id, migration.checksum]),
  );
  const ledger = await client.query<{ id: string; checksum: string | null }>(
    'SELECT id, checksum FROM schema_migrations ORDER BY id',
  );
  for (const row of ledger.rows) {
    const expectedChecksum = expected.get(row.id);
    if (!expectedChecksum) {
      throw new Error(
        `migration integrity check failed: applied migration ${row.id} is missing from this build`,
      );
    }
    if (row.checksum === null) {
      // Legacy ledgers predate checksums. The advisory lock makes this one-time
      // trust-on-upgrade backfill atomic with the subsequent NOT NULL guard.
      await client.query(
        'UPDATE schema_migrations SET checksum=$2 WHERE id=$1 AND checksum IS NULL',
        [row.id, expectedChecksum],
      );
    } else if (row.checksum !== expectedChecksum) {
      throw new Error(
        `migration integrity check failed: checksum mismatch for ${row.id}`,
      );
    }
  }

  const checksumColumn = await client.query<{ is_nullable: 'YES' | 'NO' }>(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name='schema_migrations'
        AND column_name='checksum'`,
  );
  if (checksumColumn.rows[0]?.is_nullable !== 'NO') {
    await client.query(
      'ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL',
    );
  }
}

/** Verifies the complete applied ledger, then applies each pending `*.sql` file
 * in lexicographic order inside its own transaction. */
export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    lockAcquired = true;
    const migrations = loadMigrationFiles(migrationsDir);
    await ensureMigrationsTable(client, migrations);
    for (const migration of migrations) {
      const { rows } = await client.query<{ id: string; checksum: string }>(
        'SELECT id, checksum FROM schema_migrations WHERE id = $1',
        [migration.id],
      );
      if (rows.length > 0) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
          [migration.id, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${migration.id} failed: ${(err as Error).message}`, {
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
