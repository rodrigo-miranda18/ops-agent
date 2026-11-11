export interface IncidentRepositoryEntry {
  name: string;
  role?: string | null;
  scope?: string | null;
}

export interface IncidentRepositoryAction {
  repositories?: unknown;
  confidence?: unknown;
}

export interface IncidentRepositoryCandidate {
  name: string;
}

export interface IncidentRepositoryContext<
  T extends IncidentRepositoryCandidate,
> {
  repositories?: T[];
}

export type SelectedIncidentRepository<T> = T & {
  role: string | null;
  scope: string | null;
};

export function incidentActionRepositories(
  action: IncidentRepositoryAction | null | undefined,
): IncidentRepositoryEntry[] {
  const entries: unknown[] = Array.isArray(action?.repositories)
    ? action.repositories
    : [];
  const normalized = entries
    .map((entry) => (typeof entry === 'string' ? { name: entry } : entry))
    .filter(
      (entry): entry is IncidentRepositoryEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        'name' in entry &&
        typeof entry.name === 'string' &&
        Boolean(entry.name),
    );
  return normalized.filter(
    (entry, index) =>
      normalized.findIndex((item) => item.name === entry.name) === index,
  );
}

export function selectIncidentRepositories<
  T extends IncidentRepositoryCandidate,
>(
  action: IncidentRepositoryAction | null | undefined,
  context: IncidentRepositoryContext<T> | null | undefined,
): SelectedIncidentRepository<T>[] {
  const requested = incidentActionRepositories(action);
  if (action?.confidence !== 'high' || !requested.length) return [];
  const candidates = context?.repositories || [];
  const selected = requested.map((entry) => {
    const candidate = candidates.find((item) => item.name === entry.name);
    return (
      candidate && {
        ...candidate,
        role: entry.role || null,
        scope: entry.scope || null,
      }
    );
  });
  return selected.filter((entry): entry is SelectedIncidentRepository<T> =>
    Boolean(entry),
  );
}

export function githubSlug(remote: unknown): string | null {
  const match = String(remote)
    .trim()
    .match(
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
    );
  return match?.[1] || null;
}
