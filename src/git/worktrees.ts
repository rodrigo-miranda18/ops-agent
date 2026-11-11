import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findGitRepositories, runGit } from './git.js';

function remediationPrefix(ticketId: string) {
  return `driva-remediation-${ticketId.replace(/[^A-Za-z0-9_-]/g, '_')}-`;
}

export async function prepareRemediationWorktreesDir(
  config: { reposDir: string; repositorySyncTimeoutMs: number },
  ticketId: string,
  temporaryRoot = tmpdir(),
): Promise<string> {
  const prefix = remediationPrefix(ticketId);
  const entries = await readdir(temporaryRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) =>
        rm(path.join(temporaryRoot, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );
  const repositories = await findGitRepositories(
    config.reposDir,
    [],
    () => undefined,
  );
  for (const repository of repositories)
    await runGit(config, repository, ['worktree', 'prune']);
  return mkdtemp(path.join(temporaryRoot, prefix));
}

export function removeWorktreesDir(worktreesDir: string): Promise<void> {
  return rm(worktreesDir, { recursive: true, force: true });
}
