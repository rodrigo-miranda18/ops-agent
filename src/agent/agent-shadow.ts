export interface ShadowAction {
  decision: unknown;
  confidence: unknown;
  repositories: unknown;
}

export interface ShadowComparison {
  ticketId: string;
  baseline: ShadowAction | null;
  shadow: ShadowAction | null;
  sameDecision: boolean;
  sameRepositories: boolean;
  error: string | null;
}

function repositoryKey(action: ShadowAction | null) {
  const repositories = Array.isArray(action?.repositories)
    ? action.repositories
    : [];
  return repositories
    .map((repository: { name?: string } | string) =>
      typeof repository === 'string' ? repository : repository.name,
    )
    .sort()
    .join(',');
}

export function compareShadow(
  ticketId: string,
  baseline: ShadowAction | null,
  shadow: ShadowAction | null,
  error: string | null,
): ShadowComparison {
  return {
    ticketId,
    baseline,
    shadow,
    sameDecision:
      baseline !== null &&
      shadow !== null &&
      baseline.decision === shadow.decision,
    sameRepositories:
      baseline !== null &&
      shadow !== null &&
      repositoryKey(baseline) === repositoryKey(shadow),
    error,
  };
}
