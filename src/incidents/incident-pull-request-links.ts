export const INCIDENT_PULL_REQUEST_LINK_PREFIX =
  'PRs de remediação vinculados a este incidente:';
const PULL_REQUEST_URL_PATTERN =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

export function incidentPullRequestLinkComment(
  urls: readonly string[],
): string {
  return `${INCIDENT_PULL_REQUEST_LINK_PREFIX}\n${urls.join('\n')}`;
}

export function linkedIncidentPullRequestUrls(
  commentBodies: readonly string[],
): string[] {
  const urls = new Set<string>();
  for (const body of commentBodies) {
    if (!body.includes(INCIDENT_PULL_REQUEST_LINK_PREFIX)) continue;
    for (const match of body.matchAll(PULL_REQUEST_URL_PATTERN))
      urls.add(match[0]);
  }
  return [...urls];
}
