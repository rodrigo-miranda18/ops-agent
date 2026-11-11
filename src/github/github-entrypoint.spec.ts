import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('docker entrypoint GitHub configuration', () => {
  it('configures the credential helper for legacy GH_TOKEN-only static mode', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'github-entrypoint-'));
    const bin = path.join(directory, 'bin');
    const gitLog = path.join(directory, 'git.log');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'git'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$GIT_LOG"\n',
    );
    await writeFile(path.join(bin, 'mkdir'), '#!/usr/bin/env bash\nexit 0\n');
    await chmod(path.join(bin, 'git'), 0o755);
    await chmod(path.join(bin, 'mkdir'), 0o755);

    await executeFile('bash', ['docker/entrypoint.sh', 'true'], {
      cwd: process.cwd(),
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: directory,
        GH_TOKEN: 'legacy-static-token',
        GIT_LOG: gitLog,
      },
    });

    const calls = await readFile(gitLog, 'utf8').catch(() => '');
    expect(calls).toContain(
      'config --global --replace-all credential.https://github.com.helper !node /app/dist/github/git-credential-app.js',
    );
  });
});
