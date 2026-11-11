import { readFile } from 'node:fs/promises';

export type Environment = Readonly<Record<string, string | undefined>>;

export const SYSTEM_ENVIRONMENT = [
  'PATH',
  'HOME',
  'HOSTNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
] as const;

export const CERTIFICATE_ENVIRONMENT = [
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

export const PROXY_ENVIRONMENT = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export const DEPENDENCY_ENVIRONMENT = [
  ...SYSTEM_ENVIRONMENT,
  ...CERTIFICATE_ENVIRONMENT,
  ...PROXY_ENVIRONMENT,
] as const;

export const CODEX_ENVIRONMENT = [
  ...SYSTEM_ENVIRONMENT,
  'GOROOT',
  ...CERTIFICATE_ENVIRONMENT,
  'CODEX_CA_CERTIFICATE',
  'CODEX_HOME',
  'CODEX_MODEL',
  'DRIVA_PROXY_API_KEY',
  'SALES_POSTGRESQL_HOST',
  'SALES_POSTGRESQL_PORT',
  'SALES_POSTGRESQL_USERNAME',
  'SALES_POSTGRESQL_PASSWORD',
  'SALES_POSTGRESQL_DATABASE',
  'CLICKHOUSE_URL',
  'HYPERDX_CLICKHOUSE_URL',
  'CLICKHOUSE_USER',
  'CLICKHOUSE_PASSWORD',
  'CLICKHOUSE_DATABASE',
  'CLICKHOUSE_LOGS_TABLE',
  'CLICKHOUSE_DEFAULT_LIMIT',
  'CLICKHOUSE_MAX_ROWS',
  'CLICKHOUSE_QUERY_TIMEOUT_MS',
  'CLICKHOUSE_REQUIRE_TIME_WINDOW',
] as const;

export const GITHUB_HELPER_ENVIRONMENT = [
  'GITHUB_AUTH_MODE',
  'GH_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_ORGANIZATION',
  'GITHUB_APP_HEALTH_REPOSITORY',
  'GITHUB_APP_PRIVATE_KEY_FILE',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS',
] as const;

export const GIT_IDENTITY_ENVIRONMENT = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export function pickEnv(
  names: readonly string[],
  env: Environment = process.env,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

export function codexEnvironment(
  options: { gitIdentity?: boolean; githubToken?: boolean } = {},
  env: Environment = process.env,
): Record<string, string> {
  const names: string[] = [...CODEX_ENVIRONMENT];
  if (options.gitIdentity) names.push(...GIT_IDENTITY_ENVIRONMENT);
  if (options.githubToken) names.push('GH_TOKEN');
  return pickEnv(names, env);
}

export async function loadDotEnv(
  filename: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}
