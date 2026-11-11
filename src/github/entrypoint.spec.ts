import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(
  new URL('../../docker/entrypoint.sh', import.meta.url),
);

describe('container entrypoint Git authentication', () => {
  let root: string;
  let environment: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'entrypoint-spec-'));
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'mkdir'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    environment = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      DRIVA_REPOS_DIR: path.join(root, 'repos'),
      CODEX_HOME: path.join(root, 'codex'),
      GITHUB_AUTH_MODE: 'app',
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runEntrypoint() {
    return spawnSync('bash', [entrypoint, 'printf', 'started'], {
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  function gitValues(key: string) {
    const result = spawnSync('git', ['config', '--global', '--get-all', key], {
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim().split('\n');
  }

  it.each(['app', 'static'])(
    'boots repeatedly with %s authentication without duplicate Git rewrites',
    (mode) => {
      environment.GITHUB_AUTH_MODE = mode;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = runEntrypoint();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('started');
      }

      expect(gitValues('url.https://github.com/.insteadOf')).toEqual([
        'git@github.com:',
        'ssh://git@github.com/',
      ]);
      expect(gitValues('credential.https://github.com.helper')).toEqual([
        '!node /app/dist/github/git-credential-app.js',
      ]);
    },
  );
});
