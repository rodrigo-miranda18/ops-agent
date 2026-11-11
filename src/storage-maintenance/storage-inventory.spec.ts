import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inventoryStorage } from './storage-inventory.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'storage-inventory-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixtureFile(relativePath: string, content: string) {
  const filename = path.join(root, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

describe('inventoryStorage', () => {
  it('measures state, dependency caches, repositories and old agent worktrees', async () => {
    await fixtureFile('state/processed.json', '1234');
    await fixtureFile('state/dependency-fingerprints.json', '12');
    await fixtureFile('state/notes.txt', 'not-authoritative');
    await fixtureFile('state/dependency-cache/npm/index', 'npm');
    await fixtureFile('state/dependency-cache/pnpm/index', 'pnpm!');
    await fixtureFile('state/dependency-cache/go-build/index', 'go');
    await fixtureFile('state/dependency-cache/go-mod/index', 'module');
    await fixtureFile('repos/service/.git/HEAD', 'ref: main');
    await fixtureFile('repos/service/src.ts', 'source');
    await fixtureFile('repos/service/node_modules/pkg/index.js', 'dependency');
    await fixtureFile('results/forbidden/secret.txt', 'DO_NOT_REPORT');
    await fixtureFile('secrets/token', 'ALSO_FORBIDDEN');
    await fixtureFile('tmp/driva-remediation-42-old/repo/file', 'old');
    await fixtureFile('tmp/driva-remediation-42-new/repo/file', 'new');
    await fixtureFile('tmp/unrelated/file', 'ignore');

    const oldWorktree = path.join(root, 'tmp/driva-remediation-42-old');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(oldWorktree, twoDaysAgo, twoDaysAgo);

    const inventory = await inventoryStorage({
      stateDir: path.join(root, 'state'),
      dependencyCacheDir: path.join(root, 'state/dependency-cache'),
      reposDir: path.join(root, 'repos'),
      temporaryDir: path.join(root, 'tmp'),
      worktreeMinAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(inventory.authoritativeStateBytes).toBe(6);
    expect(inventory.cacheBytesByKind).toEqual({
      npm: 3,
      pnpm: 5,
      goBuild: 2,
      goMod: 6,
    });
    expect(inventory.dependencyCacheBytes).toBe(16);
    expect(inventory.repositories).toEqual([
      {
        name: 'service',
        directory: path.join(root, 'repos/service'),
        totalBytes: 25,
        gitBytes: 9,
        dependencyBytes: 10,
      },
    ]);
    expect(inventory.orphanWorktrees).toHaveLength(1);
    expect(inventory.orphanWorktrees[0]).toMatchObject({
      directory: oldWorktree,
      bytes: 3,
    });
    expect(inventory.orphanWorktrees[0]?.ageMs).toBeGreaterThanOrEqual(
      48 * 60 * 60 * 1000,
    );
    expect(JSON.stringify(inventory)).not.toContain('DO_NOT_REPORT');
    expect(JSON.stringify(inventory)).not.toContain('ALSO_FORBIDDEN');
  });

  it('returns zero totals when optional storage roots do not exist', async () => {
    await expect(
      inventoryStorage({
        stateDir: path.join(root, 'missing-state'),
        dependencyCacheDir: path.join(root, 'missing-cache'),
        reposDir: path.join(root, 'missing-repos'),
        temporaryDir: path.join(root, 'missing-tmp'),
        worktreeMinAgeMs: 1,
      }),
    ).resolves.toEqual({
      authoritativeStateBytes: 0,
      dependencyCacheBytes: 0,
      cacheBytesByKind: { npm: 0, pnpm: 0, goBuild: 0, goMod: 0 },
      repositories: [],
      orphanWorktrees: [],
    });
  });
});
