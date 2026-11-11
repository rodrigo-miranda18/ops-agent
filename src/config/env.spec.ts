import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  codexEnvironment,
  GITHUB_HELPER_ENVIRONMENT,
  loadDotEnv,
  pickEnv,
} from './env.js';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it('picks only defined allowlisted variables', () => {
  expect(pickEnv(['A', 'B'], { A: '1', C: '3' })).toStrictEqual({ A: '1' });
});

it('adds git identity and GitHub token only when requested', () => {
  const env = {
    PATH: '/bin',
    CODEX_MODEL: 'm',
    GIT_AUTHOR_NAME: 'bot',
    GH_TOKEN: 'secret',
    CLICKUP_API_TOKEN: 'secret',
  };
  expect(codexEnvironment({}, env)).toStrictEqual({
    PATH: '/bin',
    CODEX_MODEL: 'm',
  });
  expect(
    codexEnvironment({ gitIdentity: true, githubToken: true }, env),
  ).toStrictEqual({
    PATH: '/bin',
    CODEX_MODEL: 'm',
    GIT_AUTHOR_NAME: 'bot',
    GH_TOKEN: 'secret',
  });
});

it('allows only GitHub helper configuration into remediation helpers', () => {
  expect(
    pickEnv(GITHUB_HELPER_ENVIRONMENT, {
      GITHUB_AUTH_MODE: 'app',
      GITHUB_APP_ID: '1',
      GITHUB_APP_HEALTH_REPOSITORY: 'service-15',
      GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github.pem',
      CLICKUP_API_TOKEN: 'hidden',
      SALES_POSTGRESQL_PASSWORD: 'hidden',
    }),
  ).toStrictEqual({
    GITHUB_AUTH_MODE: 'app',
    GITHUB_APP_ID: '1',
    GITHUB_APP_HEALTH_REPOSITORY: 'service-15',
    GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github.pem',
  });
});

it('loads .env without overriding existing variables', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'env-spec-'));
  const filename = path.join(directory, '.env');
  await writeFile(
    filename,
    '# comment\nA="quoted"\nB=\'single\'\nC=kept\ninvalid\n',
  );
  const env: Record<string, string | undefined> = { C: 'existing' };
  await loadDotEnv(filename, env);
  expect(env).toStrictEqual({ A: 'quoted', B: 'single', C: 'existing' });
  await loadDotEnv(path.join(directory, 'missing'), env);
});
