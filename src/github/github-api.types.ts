export interface GitHubInstallationResponse {
  id: number;
}

export interface GitHubTokenResponse {
  token: string;
  expiresAt: Date;
}

export function parseGitHubInstallationResponse(
  value: unknown,
): GitHubInstallationResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isInteger(value.id)
  )
    throw new Error(
      'GitHub installation response did not contain a numeric id',
    );
  return { id: value.id };
}

export function parseGitHubTokenResponse(value: unknown): GitHubTokenResponse {
  if (
    !isRecord(value) ||
    typeof value.token !== 'string' ||
    !value.token.trim()
  )
    throw new Error('GitHub token response did not contain a non-empty token');
  if (typeof value.expires_at !== 'string')
    throw new Error('GitHub token response did not contain a valid expires_at');
  const expiresAt = new Date(value.expires_at);
  if (Number.isNaN(expiresAt.getTime()))
    throw new Error('GitHub token response did not contain a valid expires_at');
  return { token: value.token, expiresAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
