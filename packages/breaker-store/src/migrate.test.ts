import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isMainModule } from './migrate.js';

describe('isMainModule', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('is true when argv[1] is the exact module path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuse-migrate-'));
    dirs.push(dir);
    const real = join(dir, 'migrate.js');
    writeFileSync(real, '');
    // Node's ESM loader reports `import.meta.url` through the realpath (this
    // matters on macOS, where `os.tmpdir()` itself crosses the `/var` ->
    // `/private/var` symlink), so the expected side must be realpath'd too.
    const moduleUrl = pathToFileURL(realpathSync(real)).href;

    expect(isMainModule(real, moduleUrl)).toBe(true);
  });

  it('is true when argv[1] is a symlink to the module, matching the pnpm deploy layout', () => {
    // `pnpm deploy`'s production node_modules puts the package under
    // `.pnpm/...` and symlinks it into `node_modules/@fuse/...`, so the CLI
    // is invoked through the symlink while `import.meta.url` resolves through
    // the real target.
    const dir = mkdtempSync(join(tmpdir(), 'fuse-migrate-'));
    dirs.push(dir);
    const real = join(dir, 'real-migrate.js');
    const link = join(dir, 'migrate.js');
    writeFileSync(real, '');
    symlinkSync(real, link);
    const moduleUrl = pathToFileURL(realpathSync(real)).href;

    expect(isMainModule(link, moduleUrl)).toBe(true);
  });

  it('is false when argv[1] resolves to a different file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuse-migrate-'));
    dirs.push(dir);
    const real = join(dir, 'migrate.js');
    const other = join(dir, 'other.js');
    writeFileSync(real, '');
    writeFileSync(other, '');
    const moduleUrl = pathToFileURL(realpathSync(real)).href;

    expect(isMainModule(other, moduleUrl)).toBe(false);
  });

  it('is false when argv[1] is undefined', () => {
    expect(isMainModule(undefined, 'file:///anywhere/migrate.js')).toBe(false);
  });

  it('is false without throwing when argv[1] does not exist on disk', () => {
    expect(
      isMainModule('/nonexistent/path/migrate.js', 'file:///anywhere/migrate.js'),
    ).toBe(false);
  });
});
