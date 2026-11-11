import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';

const readFileMock = vi.hoisted(() => vi.fn());
const runCodexMock = vi.hoisted(() => vi.fn());
const createWorktreesMock = vi.hoisted(() => vi.fn());
const removeWorktreesMock = vi.hoisted(() => vi.fn());
const writeJsonMock = vi.hoisted(() => vi.fn());
const writeTextMock = vi.hoisted(() => vi.fn());
const removeIfExistsMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }));
vi.mock('../runner/runner-codex.js', () => ({ runCodex: runCodexMock }));
vi.mock('../git/worktrees.js', () => ({
  prepareRemediationWorktreesDir: createWorktreesMock,
  removeWorktreesDir: removeWorktreesMock,
}));
vi.mock('../state/atomic-write.js', () => ({ writeJsonAtomic: writeJsonMock }));
vi.mock('../diagnosis/diagnosis-artifacts.js', () => ({
  removeIfExists: removeIfExistsMock,
  writeStderrArtifact: vi.fn(),
  writeTextArtifact: writeTextMock,
}));

const { runRemediation } = await import('./remediation-run.js');

const config = {
  reposDir: '/repos',
  codexBin: 'codex',
  codexModel: undefined,
  codexTimeoutMs: 1000,
  remediationTimeoutMs: 2000,
  repositorySyncTimeoutMs: 3000,
};
const ticket = { id: 'ticket-1' };
const action = {
  decision: 'CORRECTION_REQUIRED' as const,
  confidence: 'high' as const,
  summary: 'Fix required',
  reason: 'Confirmed root cause',
  repositories: [{ name: 'service-15', role: null, scope: null }],
};

function dependencies(
  ensureGitHubAccess = vi.fn(async () => undefined),
): RunnerDependencies {
  return {
    github: vi.fn(async () => ''),
    ensureGitHubAccess,
  };
}

describe('runRemediation GitHub preflight', () => {
  beforeEach(() => {
    readFileMock.mockReset().mockResolvedValue('prompt');
    runCodexMock.mockReset().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout:
        '<!-- REMEDIATION_RESULT_START -->{"status":"PR_OPENED","pull_requests":[{"url":"https://github.com/org/repo/pull/1"}]}<!-- REMEDIATION_RESULT_END -->',
      stderr: '',
    });
    createWorktreesMock.mockReset().mockResolvedValue('/worktrees');
    removeWorktreesMock.mockReset().mockResolvedValue(undefined);
    writeJsonMock.mockReset().mockResolvedValue(undefined);
    writeTextMock.mockReset().mockResolvedValue(undefined);
    removeIfExistsMock.mockReset().mockResolvedValue(undefined);
  });

  it('does not preflight GitHub for plan-only remediation', async () => {
    const deps = dependencies();

    await runRemediation(
      config,
      '/results/ticket-1',
      ticket,
      action,
      'none',
      {},
      deps,
    );

    expect(deps.ensureGitHubAccess).not.toHaveBeenCalled();
    expect(runCodexMock).not.toHaveBeenCalled();
  });

  it('preflights GitHub exactly once before automatic Codex remediation', async () => {
    const order: string[] = [];
    const deps = dependencies(
      vi.fn(async () => {
        order.push('preflight');
      }),
    );
    runCodexMock.mockImplementation(async () => {
      order.push('codex');
      return {
        exitCode: 0,
        signal: null,
        stdout:
          '<!-- REMEDIATION_RESULT_START -->{"status":"PR_OPENED","pull_requests":[{"url":"https://github.com/org/repo/pull/1"}]}<!-- REMEDIATION_RESULT_END -->',
        stderr: '',
      };
    });

    await runRemediation(
      config,
      '/results/ticket-1',
      ticket,
      action,
      'auto',
      {},
      deps,
    );

    expect(deps.ensureGitHubAccess).toHaveBeenCalledWith(['service-15']);
    expect(order).toEqual(['preflight', 'codex']);
  });

  it('returns a sanitized implementation failure without starting Codex when preflight fails', async () => {
    const deps = dependencies(
      vi.fn(async () => {
        throw new Error('Bad credentials ghs_secret-token-value');
      }),
    );

    const result = await runRemediation(
      config,
      '/results/ticket-1',
      ticket,
      action,
      'auto',
      {},
      deps,
    );

    expect(result.status).toBe('IMPLEMENTATION_FAILED');
    expect(result.reason).not.toContain('ghs_secret-token-value');
    expect(runCodexMock).not.toHaveBeenCalled();
    expect(createWorktreesMock).not.toHaveBeenCalled();
  });
});
