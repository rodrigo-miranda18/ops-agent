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

async function runLoginShell(remediation: boolean): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), 'github-shell-profile-'));
  const wrapperBin = path.join(directory, 'github-bin');
  const realBin = path.join(directory, 'bin');
  for (const [bin, output] of [
    [wrapperBin, 'wrapper'],
    [realBin, 'real'],
  ]) {
    await mkdir(bin);
    const gh = path.join(bin, 'gh');
    await writeFile(gh, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    await chmod(gh, 0o755);
  }

  const dockerfile = await readFile('Dockerfile', 'utf8');
  const profileBlock = dockerfile.match(
    /printf '%s\\n' \\\n([\s\S]*?)> \/etc\/profile\.d\/driva-github\.sh/,
  );
  const profile = (profileBlock?.[1] ?? '')
    .split('\n')
    .flatMap((line) => {
      const quoted = line.match(/^\s*'([^']*)'/);
      return quoted ? [quoted[1]] : [];
    })
    .join('\n')
    .replaceAll('/app/github-bin', wrapperBin);
  const profileFile = path.join(directory, 'profile.sh');
  await writeFile(profileFile, profile);

  const { stdout } = await executeFile(
    '/bin/sh',
    [
      '-lc',
      'PATH="$REAL_BIN:/usr/bin:/bin"; export PATH; . "$PROFILE_FILE"; gh',
    ],
    {
      env: {
        PATH: `${wrapperBin}:${realBin}:/usr/bin:/bin`,
        HOME: directory,
        REAL_BIN: realBin,
        PROFILE_FILE: profileFile,
        ...(remediation ? { DRIVA_REAL_PATH: `${realBin}:/usr/bin:/bin` } : {}),
      },
      timeout: 5_000,
    },
  );
  return stdout.trim();
}

describe('GitHub wrapper in login shells', () => {
  it('restores the wrapper after the login profile resets PATH during remediation', async () => {
    expect(await runLoginShell(true)).toBe('wrapper');
  });

  it('does not enable the wrapper in diagnosis shells', async () => {
    expect(await runLoginShell(false)).toBe('real');
  });
});
