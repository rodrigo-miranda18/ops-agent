import { agentConfigFromEnv } from './agent-config.js';
import path from 'node:path';
import { parseDiagnosisVectors } from '../diagnosis/vector-classification.js';
import { parseClickUpAreaValues } from './area-values.js';
import { DEPENDENCY_ENVIRONMENT, type Environment, pickEnv } from './env.js';
import { githubConfigFromEnv } from './github-config.js';

export const DEFAULT_RUNNER_REPOS_DIR =
  '/home/usuario/Documents/projects/driva-ops-agent/repos';

export interface RunnerConfigArgs {
  incidentId?: string;
  maxTickets?: number;
  createdWithinMinutes?: number;
}

export function positiveInteger(value: string | undefined, name: string) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function csv(value = '') {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function runnerConfigFromEnv(
  args: RunnerConfigArgs,
  env: Environment = process.env,
) {
  const required = args.incidentId
    ? ['DIAGNOSIS_VECTORS']
    : ['CLICKUP_API_TOKEN', 'CLICKUP_LIST_ID', 'DIAGNOSIS_VECTORS'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length)
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);

  return {
    token: env.CLICKUP_API_TOKEN,
    get github() {
      return githubConfigFromEnv(env);
    },
    listId: env.CLICKUP_LIST_ID,
    taskType: env.CLICKUP_TASK_TYPE || 'bug',
    taskTypeId: env.CLICKUP_TASK_TYPE_ID || '1004',
    ticketTypeFieldId: env.CLICKUP_TICKET_TYPE_FIELD_ID || '',
    ticketTypeField: env.CLICKUP_TICKET_TYPE_FIELD || 'Tipo do ticket',
    ticketTypeValue: env.CLICKUP_TICKET_TYPE_VALUE || 'bug',
    areaFieldId: env.CLICKUP_AREA_FIELD_ID || '',
    areaField: env.CLICKUP_AREA_FIELD || 'Área',
    areaValues: parseClickUpAreaValues(
      env.CLICKUP_AREA_VALUES,
      env.CLICKUP_AREA_VALUE,
    ),
    vectorsFieldId: env.CLICKUP_VECTORS_FIELD_ID || '',
    vectorsField: env.CLICKUP_VECTORS_FIELD || 'Vetores',
    diagnosisVectors: parseDiagnosisVectors(env.DIAGNOSIS_VECTORS),
    statuses: csv(env.CLICKUP_STATUSES),
    tags: csv(env.CLICKUP_TAGS),
    includeSubtasks: parseBoolean(env.CLICKUP_INCLUDE_SUBTASKS, true),
    createdWithinMinutes:
      args.createdWithinMinutes ||
      positiveInteger(
        env.CLICKUP_CREATED_WITHIN_MINUTES || '60',
        'CLICKUP_CREATED_WITHIN_MINUTES',
      ),
    maxTickets:
      args.maxTickets ||
      positiveInteger(env.CLICKUP_MAX_TICKETS || '3', 'CLICKUP_MAX_TICKETS'),
    reposDir: env.DRIVA_REPOS_DIR || DEFAULT_RUNNER_REPOS_DIR,
    codexBin: env.CODEX_BIN || 'codex',
    agent: agentConfigFromEnv(env),
    codexModel: env.CODEX_MODEL,
    codexTimeoutMs:
      positiveInteger(
        env.CODEX_TIMEOUT_MINUTES || '45',
        'CODEX_TIMEOUT_MINUTES',
      ) * 60_000,
    maxAttachments: positiveInteger(
      env.CLICKUP_MAX_ATTACHMENTS || '10',
      'CLICKUP_MAX_ATTACHMENTS',
    ),
    maxAttachmentBytes:
      positiveInteger(
        env.CLICKUP_MAX_ATTACHMENT_MB || '50',
        'CLICKUP_MAX_ATTACHMENT_MB',
      ) *
      1024 *
      1024,
    concurrency: positiveInteger(
      env.RUNNER_CONCURRENCY || '3',
      'RUNNER_CONCURRENCY',
    ),
    remediationTimeoutMs:
      positiveInteger(
        env.REMEDIATION_TIMEOUT_MINUTES || '90',
        'REMEDIATION_TIMEOUT_MINUTES',
      ) * 60_000,
    repositorySyncTimeoutMs:
      positiveInteger(
        env.REPOSITORY_SYNC_TIMEOUT_MINUTES || '5',
        'REPOSITORY_SYNC_TIMEOUT_MINUTES',
      ) * 60_000,
    repositorySyncIgnore: csv(env.REPOSITORY_SYNC_IGNORE),
    dependencySyncEnabled: parseBoolean(env.DEPENDENCY_SYNC_ENABLED, true),
    dependencySyncTimeoutMs:
      positiveInteger(
        env.DEPENDENCY_SYNC_TIMEOUT_MINUTES || '30',
        'DEPENDENCY_SYNC_TIMEOUT_MINUTES',
      ) * 60_000,
  };
}

export type RunnerConfig = ReturnType<typeof runnerConfigFromEnv>;

export function codexHomeDir(reposDir: string, env: Environment = process.env) {
  return env.CODEX_HOME || path.join(reposDir, '.codex');
}

export function dependencyEnvironment(
  projectName: string,
  env: Environment = process.env,
): Record<string, string> {
  const environment = pickEnv(DEPENDENCY_ENVIRONMENT, env);
  if (projectName === 'service-17') {
    if (!env.GITHUB_DDS_TOKEN)
      throw new Error(
        'GITHUB_DDS_TOKEN is required to install service-17 private packages',
      );
    environment.GITHUB_DDS_TOKEN = env.GITHUB_DDS_TOKEN;
  }
  return { ...environment, CI: 'true', HUSKY: '0', NODE_ENV: 'development' };
}

export interface DiagnosisEnvVariable {
  source: string;
  target: string;
  required?: boolean;
  fallback?: string;
  /** Written into the file but does not, on its own, mark the group as configured. */
  shared?: boolean;
}

export interface DiagnosisEnvFileDefinition {
  name: string;
  filename: (reposDir: string) => string;
  variables: readonly DiagnosisEnvVariable[];
}

function sameName(name: string): DiagnosisEnvVariable {
  return { source: name, target: name };
}

function sharedLogsClickHouse(): DiagnosisEnvVariable[] {
  return ['HOST', 'PORT', 'PROTOCOL', 'USER', 'PASSWORD'].map((suffix) => ({
    ...sameName(`DRIVA_LOGS_CH_${suffix}`),
    shared: true,
  }));
}

export const DIAGNOSIS_ENV_FILES: readonly DiagnosisEnvFileDefinition[] = [
  {
    name: 'export',
    filename: (reposDir) => path.join(reposDir, 'service-12', '.env'),
    variables: [
      {
        source: 'INTEGRATIONS_EXPORTS_PG_HOST',
        target: 'POSTGRES_HOST',
        required: true,
      },
      {
        source: 'INTEGRATIONS_EXPORTS_PG_PORT',
        target: 'POSTGRES_PORT',
        fallback: '5432',
      },
      {
        source: 'INTEGRATIONS_EXPORTS_PG_USER',
        target: 'POSTGRES_USER',
        required: true,
      },
      {
        source: 'INTEGRATIONS_EXPORTS_PG_PASSWORD',
        target: 'POSTGRES_PASSWORD',
        required: true,
      },
      {
        source: 'INTEGRATIONS_EXPORTS_PG_DATABASE',
        target: 'POSTGRES_EXPORTS_DATABASE',
        required: true,
      },
      ...sharedLogsClickHouse(),
    ],
  },
  {
    name: 'hunter',
    filename: (reposDir) => path.join(reposDir, 'service-11', '.env'),
    variables: [
      {
        source: 'HUNTER_DATABASE_READONLY_URL',
        target: 'DATABASE_READONLY_URL',
        required: true,
      },
    ],
  },
  {
    name: 'service-16',
    filename: (reposDir) => path.join(reposDir, 'service-16', '.env'),
    variables: [
      {
        source: 'INTEGRATIONS_PG_HOST',
        target: 'PG_INTEGRATIONS_HOST',
        required: true,
      },
      {
        source: 'INTEGRATIONS_PG_PORT',
        target: 'PG_INTEGRATIONS_PORT',
        fallback: '5432',
      },
      {
        source: 'INTEGRATIONS_PG_USER',
        target: 'PG_INTEGRATIONS_USER',
        required: true,
      },
      {
        source: 'INTEGRATIONS_PG_PASSWORD',
        target: 'PG_INTEGRATIONS_PASSWORD',
        required: true,
      },
      {
        source: 'INTEGRATIONS_PG_DATABASE',
        target: 'PG_INTEGRATIONS_DB',
        required: true,
      },
      { source: 'INTEGRATIONS_EXPORTS_PG_HOST', target: 'PG_EXPORTS_HOST' },
      { source: 'INTEGRATIONS_EXPORTS_PG_PORT', target: 'PG_EXPORTS_PORT' },
      { source: 'INTEGRATIONS_EXPORTS_PG_USER', target: 'PG_EXPORTS_USER' },
      {
        source: 'INTEGRATIONS_EXPORTS_PG_PASSWORD',
        target: 'PG_EXPORTS_PASSWORD',
      },
      { source: 'INTEGRATIONS_EXPORTS_PG_DATABASE', target: 'PG_EXPORTS_DB' },
      { source: 'INTEGRATIONS_CLIENTS_PG_HOST', target: 'PG_CLIENTES_HOST' },
      { source: 'INTEGRATIONS_CLIENTS_PG_PORT', target: 'PG_CLIENTES_PORT' },
      { source: 'INTEGRATIONS_CLIENTS_PG_USER', target: 'PG_CLIENTES_USER' },
      {
        source: 'INTEGRATIONS_CLIENTS_PG_PASSWORD',
        target: 'PG_CLIENTES_PASSWORD',
      },
      {
        source: 'INTEGRATIONS_CLIENTS_PG_DATABASE',
        target: 'PG_CLIENTES_NAME',
      },
      ...sharedLogsClickHouse(),
    ],
  },
  {
    name: 'linkedin',
    filename: (reposDir) =>
      path.join(reposDir, 'service-09', 'linkedin-api', '.env'),
    variables: [
      {
        source: 'LINKEDIN_DATABASE_URL',
        target: 'DATABASE_URL',
        required: true,
      },
    ],
  },
  {
    name: 'mail',
    filename: (reposDir) => path.join(reposDir, 'service-15', '.env'),
    variables: [
      { source: 'MAIL_POSTGRES_HOST', target: 'POSTGRES_HOST', required: true },
      {
        source: 'MAIL_POSTGRES_PORT',
        target: 'POSTGRES_PORT',
        fallback: '5432',
      },
      {
        source: 'MAIL_POSTGRES_USERNAME',
        target: 'POSTGRES_USERNAME',
        required: true,
      },
      {
        source: 'MAIL_POSTGRES_PASSWORD',
        target: 'POSTGRES_PASSWORD',
        required: true,
      },
      {
        source: 'MAIL_POSTGRES_DATABASE',
        target: 'POSTGRES_DATABASE',
        required: true,
      },
      { source: 'MAIL_POSTGRES_SCHEMA', target: 'POSTGRES_SCHEMA' },
    ],
  },
  {
    name: 'management',
    filename: (reposDir) => path.join(reposDir, 'service-02', '.env'),
    variables: [
      { source: 'MANAGEMENT_PG_HOST', target: 'PGHOST', required: true },
      { source: 'MANAGEMENT_PG_PORT', target: 'PGPORT', fallback: '5432' },
      { source: 'MANAGEMENT_PG_USER', target: 'PGUSER', required: true },
      {
        source: 'MANAGEMENT_PG_PASSWORD',
        target: 'PGPASSWORD',
        required: true,
      },
      {
        source: 'MANAGEMENT_PG_DATABASE',
        target: 'PGDATABASE',
        required: true,
      },
    ],
  },
  {
    name: 'service-10',
    filename: (reposDir) => path.join(reposDir, 'service-10', '.env'),
    variables: [
      ['BUCKET', true],
      ['REGION', false],
      ['ENDPOINT_URL', false],
      ['USE_PATH_STYLE', false],
      ['ACCESS_KEY_ID', true],
      ['SECRET_ACCESS_KEY', true],
    ].map(([suffix, required]) => ({
      ...sameName(`MARKET_INTELLIGENCE_STORAGE_S3_${suffix}`),
      required: required as boolean,
    })),
  },
  {
    name: 'search-go',
    filename: (reposDir) => path.join(reposDir, 'service-13', '.env'),
    variables: [
      {
        source: 'DRIVA_LIST_PG_HOST',
        target: 'POSTGRES_BLACKLIST_HOST',
        required: true,
      },
      {
        source: 'DRIVA_LIST_PG_PORT',
        target: 'POSTGRES_BLACKLIST_PORT',
        fallback: '5432',
      },
      {
        source: 'DRIVA_LIST_PG_DATABASE',
        target: 'POSTGRES_BLACKLIST_DATABASE',
        required: true,
      },
      {
        source: 'DRIVA_LIST_PG_USER',
        target: 'POSTGRES_BLACKLIST_USERNAME',
        required: true,
      },
      {
        source: 'DRIVA_LIST_PG_PASSWORD',
        target: 'POSTGRES_BLACKLIST_PASSWORD',
        required: true,
      },
      ...['HOST', 'PORT', 'USER', 'PASSWORD'].map((suffix) =>
        sameName(`DRIVA_SEARCH_CH_${suffix}`),
      ),
      ...['URL', 'USER', 'PASSWORD'].map((suffix) =>
        sameName(`DRIVA_RABBITMQ_MANAGEMENT_${suffix}`),
      ),
      ...sharedLogsClickHouse(),
    ],
  },
  {
    name: 'whatsapp-cloud',
    filename: (reposDir) => path.join(reposDir, 'service-01', '.env'),
    variables: [
      {
        source: 'WHATSAPP_CLOUD_POSTGRES_HOST',
        target: 'POSTGRES_HOST',
        required: true,
      },
      {
        source: 'WHATSAPP_CLOUD_POSTGRES_PORT',
        target: 'POSTGRES_PORT',
        fallback: '5432',
      },
      {
        source: 'WHATSAPP_CLOUD_POSTGRES_USERNAME',
        target: 'POSTGRES_USERNAME',
        required: true,
      },
      {
        source: 'WHATSAPP_CLOUD_POSTGRES_PASSWORD',
        target: 'POSTGRES_PASSWORD',
        required: true,
      },
      {
        source: 'WHATSAPP_CLOUD_POSTGRES_DATABASE',
        target: 'POSTGRES_DATABASE',
        required: true,
      },
      { source: 'WHATSAPP_CLOUD_POSTGRES_SSLMODE', target: 'POSTGRES_SSLMODE' },
    ],
  },
];

export type DiagnosisEnvFile =
  | { name: string; configured: false }
  | { name: string; configured: true; filename: string; content: string };

export function diagnosisEnvFile(
  definition: DiagnosisEnvFileDefinition,
  reposDir: string,
  env: Environment = process.env,
): DiagnosisEnvFile {
  // Shared variables (such as the logs ClickHouse) do not mark a group as configured.
  const configured = definition.variables.some(
    ({ source, shared }) => !shared && env[source]?.trim(),
  );
  if (!configured) return { name: definition.name, configured: false };

  const missing = definition.variables
    .filter(({ source, required }) => required && !env[source]?.trim())
    .map(({ source }) => source);
  if (missing.length) {
    throw new Error(
      `Incomplete ${definition.name} diagnosis database configuration; missing: ${missing.join(', ')}`,
    );
  }

  const lines = ['# Generated by driva-ops-agent. Do not edit.'];
  for (const { source, target, fallback } of definition.variables) {
    const value = env[source]?.trim() || fallback;
    if (value === undefined || value === '') continue;
    if (/[\r\n]/.test(value)) throw new Error(`Invalid newline in ${source}`);
    lines.push(`${target}=${value}`);
  }
  return {
    name: definition.name,
    configured: true,
    filename: definition.filename(reposDir),
    content: `${lines.join('\n')}\n`,
  };
}
