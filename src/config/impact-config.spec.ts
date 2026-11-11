import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { impactCodexConfigFromEnv } from './impact-config.js';

describe('impactCodexConfigFromEnv', () => {
  it('applies defaults relative to the project directory', () => {
    expect(impactCodexConfigFromEnv('/project', {})).toMatchObject({
      reposDir: path.resolve('/project/repos'),
      codexBin: 'codex',
      model: undefined,
      sandboxMode: undefined,
      timeoutMs: 900_000,
    });
  });

  it('reads overrides from the environment', () => {
    expect(
      impactCodexConfigFromEnv('/project', {
        DRIVA_REPOS_DIR: '/repos',
        CODEX_BIN: '/bin/codex',
        CODEX_MODEL: 'gpt',
        IMPACT_CODEX_SANDBOX_MODE: 'read-only',
        CODEX_TIMEOUT_MS: '1000',
      }),
    ).toMatchObject({
      reposDir: '/repos',
      codexBin: '/bin/codex',
      model: 'gpt',
      sandboxMode: 'read-only',
      timeoutMs: 1000,
    });
  });

  it('prefers IMPACT_CODEX_TIMEOUT_MS over CODEX_TIMEOUT_MS', () => {
    expect(
      impactCodexConfigFromEnv('/project', {
        IMPACT_CODEX_TIMEOUT_MS: '5',
        CODEX_TIMEOUT_MS: '1000',
      }).timeoutMs,
    ).toBe(5);
  });
});
