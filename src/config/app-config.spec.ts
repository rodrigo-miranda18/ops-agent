import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appConfigFromEnv,
  appReposDir,
  codexBin,
  configurationSummary,
} from './app-config.js';

describe('appConfigFromEnv', () => {
  it('applies defaults when nothing is set', () => {
    expect(appConfigFromEnv({})).toEqual({
      port: 3000,
      host: '0.0.0.0',
      diagnosisCron: '*/5 * * * *',
      diagnosisCronEnabled: false,
      diagnosisExecutionConcurrency: 2,
      stalePrCleanupCron: '17 9 * * *',
      stalePrCleanupEnabled: false,
      stalePrMaxAgeDays: 14,
      staleIssueMaxAgeDays: 30,
    });
  });

  it('reads overrides from the environment', () => {
    expect(
      appConfigFromEnv({
        PORT: '8080',
        HOST: '127.0.0.1',
        DIAGNOSIS_CRON: '0 * * * *',
        DIAGNOSIS_CRON_ENABLED: 'true',
        DIAGNOSIS_EXECUTION_CONCURRENCY: '4',
        STALE_PR_CLEANUP_CRON: '0 3 * * 1',
        STALE_PR_CLEANUP_ENABLED: 'true',
        STALE_PR_MAX_AGE_DAYS: '30',
        STALE_ISSUE_MAX_AGE_DAYS: '60',
      }),
    ).toEqual({
      port: 8080,
      host: '127.0.0.1',
      diagnosisCron: '0 * * * *',
      diagnosisCronEnabled: true,
      diagnosisExecutionConcurrency: 4,
      stalePrCleanupCron: '0 3 * * 1',
      stalePrCleanupEnabled: true,
      stalePrMaxAgeDays: 30,
      staleIssueMaxAgeDays: 60,
    });
  });

  it('accepts true, false and empty for DIAGNOSIS_CRON_ENABLED', () => {
    expect(
      appConfigFromEnv({ DIAGNOSIS_CRON_ENABLED: 'false' })
        .diagnosisCronEnabled,
    ).toBe(false);
    expect(
      appConfigFromEnv({ DIAGNOSIS_CRON_ENABLED: '' }).diagnosisCronEnabled,
    ).toBe(false);
  });

  it('accepts serial diagnosis execution concurrency', () => {
    expect(
      appConfigFromEnv({ DIAGNOSIS_EXECUTION_CONCURRENCY: '1' })
        .diagnosisExecutionConcurrency,
    ).toBe(1);
  });

  it.each(['0', '-1', '1.5', 'abc', '07'])(
    'rejects DIAGNOSIS_EXECUTION_CONCURRENCY=%s',
    (value) => {
      expect(() =>
        appConfigFromEnv({ DIAGNOSIS_EXECUTION_CONCURRENCY: value }),
      ).toThrow(
        `DIAGNOSIS_EXECUTION_CONCURRENCY must be a positive integer, received: ${value}`,
      );
    },
  );

  it('rejects a non-numeric PORT', () => {
    expect(() => appConfigFromEnv({ PORT: 'abc' })).toThrow(
      'PORT must be numeric, received: abc',
    );
  });

  it('rejects an invalid DIAGNOSIS_CRON', () => {
    expect(() => appConfigFromEnv({ DIAGNOSIS_CRON: 'every minute' })).toThrow(
      'DIAGNOSIS_CRON is not a valid cron expression: every minute',
    );
  });

  it.each(['maybe', 'yes', '1', 'no', '0', 'TRUE'])(
    'rejects DIAGNOSIS_CRON_ENABLED=%s',
    (value) => {
      expect(() => appConfigFromEnv({ DIAGNOSIS_CRON_ENABLED: value })).toThrow(
        `DIAGNOSIS_CRON_ENABLED must be true or false, received: ${value}`,
      );
    },
  );

  it('rejects an invalid STALE_PR_CLEANUP_CRON', () => {
    expect(() => appConfigFromEnv({ STALE_PR_CLEANUP_CRON: 'daily' })).toThrow(
      'STALE_PR_CLEANUP_CRON is not a valid cron expression: daily',
    );
  });

  it('rejects STALE_PR_CLEANUP_ENABLED outside true or false', () => {
    expect(() => appConfigFromEnv({ STALE_PR_CLEANUP_ENABLED: 'yes' })).toThrow(
      'STALE_PR_CLEANUP_ENABLED must be true or false, received: yes',
    );
  });

  it.each(
    ['STALE_PR_MAX_AGE_DAYS', 'STALE_ISSUE_MAX_AGE_DAYS'].flatMap((name) =>
      ['0', '-1', '1.5', 'abc', '07'].map((value) => [name, value]),
    ),
  )('rejects %s=%s', (name, value) => {
    expect(() => appConfigFromEnv({ [name]: value })).toThrow(
      `${name} must be a positive integer, received: ${value}`,
    );
  });

  it('rejects an invalid GOOGLE_CHAT_VECTOR_SPACES_JSON', () => {
    expect(() =>
      appConfigFromEnv({ GOOGLE_CHAT_VECTOR_SPACES_JSON: '{not json' }),
    ).toThrow('GOOGLE_CHAT_VECTOR_SPACES_JSON must be a JSON object');
  });
});

describe('app config helpers', () => {
  it('defaults the repos dir to cwd/repos and codex binary to codex', () => {
    expect(appReposDir({})).toBe(path.resolve(process.cwd(), 'repos'));
    expect(appReposDir({ DRIVA_REPOS_DIR: '/srv/repos' })).toBe('/srv/repos');
    expect(codexBin({})).toBe('codex');
    expect(codexBin({ CODEX_BIN: '/usr/bin/codex' })).toBe('/usr/bin/codex');
  });

  it('summarizes configuration without exposing values', () => {
    const summary = configurationSummary({
      CODEX_MODEL: 'gpt',
      GH_TOKEN: 'github-secret',
      GITHUB_DDS_TOKEN: 'packages-secret',
      CLICKUP_API_TOKEN: 'secret',
      CLICKUP_AREA_VALUE: 'Engagement',
      HYPERDX_CLICKHOUSE_URL: 'http://ch',
      GOOGLE_CHAT_AUDIENCE: 'https://chat',
      DRIVA_PROXY_API_KEY: '   ',
    });
    expect(Object.keys(summary)).toEqual([
      'codexModel',
      'proxyCredential',
      'githubCredential',
      'githubPackages',
      'clickUp',
      'clickUpAreas',
      'diagnosisVectors',
      'engagementDatabase',
      'exportDatabase',
      'clickHouse',
      'hunterDatabase',
      'integrationsDatabase',
      'linkedinDatabase',
      'mailDatabase',
      'managementDatabase',
      'marketAnalysisStorage',
      'searchGoDatabase',
      'whatsappCloudDatabase',
      'googleChat',
    ]);
    expect(summary).toMatchObject({
      codexModel: true,
      proxyCredential: false,
      githubCredential: true,
      githubPackages: true,
      clickUp: false,
      clickUpAreas: true,
      clickHouse: true,
      googleChat: true,
    });
    expect(Object.values(summary).every((v) => typeof v === 'boolean')).toBe(
      true,
    );
  });

  it('reports valid App credentials without exposing their values', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'app-config-'));
    const keyPath = path.join(directory, 'github.pem');
    writeFileSync(keyPath, 'test private key', { mode: 0o600 });

    try {
      expect(
        configurationSummary({
          GITHUB_AUTH_MODE: 'app',
          GITHUB_APP_ID: '123',
          GITHUB_APP_CLIENT_ID: 'Iv1.client',
          GITHUB_APP_ORGANIZATION: 'Example-org',
          GITHUB_APP_HEALTH_REPOSITORY: 'service-15',
          GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
        }).githubCredential,
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports invalid GitHub configuration as unavailable', () => {
    expect(
      configurationSummary({ GITHUB_AUTH_MODE: 'app' }).githubCredential,
    ).toBe(false);
  });
});
