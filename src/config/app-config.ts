import path from 'node:path';
import { validateCronExpression } from 'cron';
import { type Environment } from './env.js';
import { googleChatConfig, parseVectorSpaces } from './google-chat-config.js';
import { githubConfigFromEnv } from './github-config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const DEFAULT_DIAGNOSIS_CRON = '*/5 * * * *';
export const DEFAULT_STALE_PR_CLEANUP_CRON = '17 9 * * *';
export const DEFAULT_STALE_PR_MAX_AGE_DAYS = 14;
export const DEFAULT_STALE_ISSUE_MAX_AGE_DAYS = 30;

export interface AppConfig {
  port: number;
  host: string;
  diagnosisCron: string;
  diagnosisCronEnabled: boolean;
  diagnosisExecutionConcurrency: number;
  stalePrCleanupCron: string;
  stalePrCleanupEnabled: boolean;
  stalePrMaxAgeDays: number;
  staleIssueMaxAgeDays: number;
}

export function appConfigFromEnv(env: Environment = process.env): AppConfig {
  const port = env.PORT || '3000';
  if (!/^\d+$/.test(port))
    throw new Error(`PORT must be numeric, received: ${port}`);

  const diagnosisCron = env.DIAGNOSIS_CRON || DEFAULT_DIAGNOSIS_CRON;
  const cron = validateCronExpression(diagnosisCron);
  if (!cron.valid)
    throw new Error(
      `DIAGNOSIS_CRON is not a valid cron expression: ${diagnosisCron}`,
    );

  const cronEnabled = parseBoolean(env, 'DIAGNOSIS_CRON_ENABLED');

  const stalePrCleanupCron =
    env.STALE_PR_CLEANUP_CRON || DEFAULT_STALE_PR_CLEANUP_CRON;
  if (!validateCronExpression(stalePrCleanupCron).valid)
    throw new Error(
      `STALE_PR_CLEANUP_CRON is not a valid cron expression: ${stalePrCleanupCron}`,
    );

  parseVectorSpaces(googleChatConfig(env).vectorSpacesJson);

  return {
    port: Number(port),
    host: env.HOST || '0.0.0.0',
    diagnosisCron,
    diagnosisCronEnabled: cronEnabled,
    diagnosisExecutionConcurrency: parsePositiveInteger(
      env,
      'DIAGNOSIS_EXECUTION_CONCURRENCY',
      2,
    ),
    stalePrCleanupCron,
    stalePrCleanupEnabled: parseBoolean(env, 'STALE_PR_CLEANUP_ENABLED'),
    stalePrMaxAgeDays: parsePositiveInteger(
      env,
      'STALE_PR_MAX_AGE_DAYS',
      DEFAULT_STALE_PR_MAX_AGE_DAYS,
    ),
    staleIssueMaxAgeDays: parsePositiveInteger(
      env,
      'STALE_ISSUE_MAX_AGE_DAYS',
      DEFAULT_STALE_ISSUE_MAX_AGE_DAYS,
    ),
  };
}

function parsePositiveInteger(
  env: Environment,
  name: string,
  fallback: number,
): number {
  const value = env[name] || String(fallback);
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`${name} must be a positive integer, received: ${value}`);
  return Number(value);
}

function parseBoolean(env: Environment, name: string): boolean {
  const value = env[name] || 'false';
  if (value !== 'true' && value !== 'false')
    throw new Error(`${name} must be true or false, received: ${value}`);
  return value === 'true';
}

export function appReposDir(env: Environment = process.env) {
  return path.resolve(env.DRIVA_REPOS_DIR || path.join(process.cwd(), 'repos'));
}

export function codexBin(env: Environment = process.env) {
  return env.CODEX_BIN || 'codex';
}

export function codexModel(env: Environment = process.env) {
  return env.CODEX_MODEL;
}

export function googleApplicationCredentials(env: Environment = process.env) {
  return env.GOOGLE_APPLICATION_CREDENTIALS;
}

export function configurationSummary(env: Environment = process.env) {
  const configured = (name: string) => Boolean(env[name]?.trim());
  const configuredAll = (names: string[]) => names.every(configured);
  return {
    codexModel: configured('CODEX_MODEL'),
    proxyCredential: configured('DRIVA_PROXY_API_KEY'),
    githubCredential: hasValidGitHubConfig(env),
    githubPackages: configured('GITHUB_DDS_TOKEN'),
    clickUp: configured('CLICKUP_API_TOKEN') && configured('CLICKUP_LIST_ID'),
    clickUpAreas:
      configured('CLICKUP_AREA_VALUES') || configured('CLICKUP_AREA_VALUE'),
    diagnosisVectors: configured('DIAGNOSIS_VECTORS'),
    engagementDatabase: configuredAll([
      'SALES_POSTGRESQL_HOST',
      'SALES_POSTGRESQL_USERNAME',
      'SALES_POSTGRESQL_PASSWORD',
      'SALES_POSTGRESQL_DATABASE',
    ]),
    exportDatabase: configuredAll([
      'INTEGRATIONS_EXPORTS_PG_HOST',
      'INTEGRATIONS_EXPORTS_PG_USER',
      'INTEGRATIONS_EXPORTS_PG_PASSWORD',
      'INTEGRATIONS_EXPORTS_PG_DATABASE',
    ]),
    clickHouse:
      configured('CLICKHOUSE_URL') || configured('HYPERDX_CLICKHOUSE_URL'),
    hunterDatabase: configured('HUNTER_DATABASE_READONLY_URL'),
    integrationsDatabase: configuredAll([
      'INTEGRATIONS_PG_HOST',
      'INTEGRATIONS_PG_USER',
      'INTEGRATIONS_PG_PASSWORD',
      'INTEGRATIONS_PG_DATABASE',
    ]),
    linkedinDatabase: configured('LINKEDIN_DATABASE_URL'),
    mailDatabase: configuredAll([
      'MAIL_POSTGRES_HOST',
      'MAIL_POSTGRES_USERNAME',
      'MAIL_POSTGRES_PASSWORD',
      'MAIL_POSTGRES_DATABASE',
    ]),
    managementDatabase: configuredAll([
      'MANAGEMENT_PG_HOST',
      'MANAGEMENT_PG_USER',
      'MANAGEMENT_PG_PASSWORD',
      'MANAGEMENT_PG_DATABASE',
    ]),
    marketAnalysisStorage: configuredAll([
      'MARKET_INTELLIGENCE_STORAGE_S3_BUCKET',
      'MARKET_INTELLIGENCE_STORAGE_S3_ACCESS_KEY_ID',
      'MARKET_INTELLIGENCE_STORAGE_S3_SECRET_ACCESS_KEY',
    ]),
    searchGoDatabase: configuredAll([
      'DRIVA_LIST_PG_HOST',
      'DRIVA_LIST_PG_USER',
      'DRIVA_LIST_PG_PASSWORD',
      'DRIVA_LIST_PG_DATABASE',
    ]),
    whatsappCloudDatabase: configuredAll([
      'WHATSAPP_CLOUD_POSTGRES_HOST',
      'WHATSAPP_CLOUD_POSTGRES_USERNAME',
      'WHATSAPP_CLOUD_POSTGRES_PASSWORD',
      'WHATSAPP_CLOUD_POSTGRES_DATABASE',
    ]),
    googleChat:
      configured('GOOGLE_CLOUD_PROJECT_NUMBER') ||
      configured('GOOGLE_CHAT_AUDIENCE'),
  };
}

export type ConfigurationSummary = ReturnType<typeof configurationSummary>;

function hasValidGitHubConfig(env: Environment): boolean {
  try {
    githubConfigFromEnv(env);
    return true;
  } catch {
    return false;
  }
}
