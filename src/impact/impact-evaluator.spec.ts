import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCodexExecMock = vi.hoisted(() => vi.fn());
vi.mock('../codex/codex.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex/codex.js')>()),
  runCodexExec: runCodexExecMock,
}));

const { evaluateTicketImpact, loadImpactContext } =
  await import('./impact-evaluator.js');

const dimension = { level: 2, rationale: 'r', evidence: ['fonte'] };
const assessment = {
  stage: 'observed',
  confidence: 'high',
  attribution: 'PRODUCT_DEFECT',
  attribution_rationale: 'reproduzido',
  dimensions: {
    reach: dimension,
    functional_consequence: dimension,
    journey_criticality: dimension,
    duration: dimension,
    incidence: dimension,
  },
  measurement: {
    affected_count: null,
    eligible_count: null,
    affected_accounts: null,
    eligible_accounts: null,
    affected_users: null,
    eligible_users: null,
    affected_operations: null,
    eligible_operations: null,
    unit: null,
    window_start: null,
    window_end: null,
    sources: [],
    limitations: [],
  },
  special_conditions: [],
};

const baseOptions = {
  reposDir: '/repos',
  codexBin: 'codex',
  model: 'gpt-x',
  sandboxMode: undefined,
  timeoutMs: 1000,
};

describe('impact evaluator', () => {
  let ticketDir: string;
  let promptPath: string;

  beforeEach(async () => {
    ticketDir = await mkdtemp(path.join(tmpdir(), 'impact-'));
    promptPath = path.join(ticketDir, 'prompt.md');
    await writeFile(promptPath, 'context: {{IMPACT_CONTEXT_JSON}}');
    await writeFile(
      path.join(ticketDir, 'ticket.json'),
      JSON.stringify({ id: 'T1', name: 'Bug' }),
    );
    runCodexExecMock.mockReset();
  });

  afterEach(async () => {
    await rm(ticketDir, { recursive: true, force: true });
  });

  it('carrega o contexto com artefatos opcionais ausentes como null', async () => {
    await writeFile(path.join(ticketDir, 'diagnosis.md'), '  causa  \n');
    expect(await loadImpactContext(ticketDir)).toEqual({
      ticket: { id: 'T1', name: 'Bug' },
      existing_run: null,
      technical_diagnosis: 'causa',
      cs_comment: null,
      engineering_action: null,
      remediation: null,
    });
  });

  it('recusa tickets que não são bug confirmado', async () => {
    await writeFile(
      path.join(ticketDir, 'run.json'),
      JSON.stringify({ classification: 'Dúvida' }),
    );
    await expect(
      evaluateTicketImpact({ ...baseOptions, ticketDir, promptPath }),
    ).rejects.toThrow('only available for confirmed bugs');
    expect(runCodexExecMock).not.toHaveBeenCalled();
  });

  it('roda o Codex somente leitura e calcula o impacto a partir do marcador', async () => {
    await writeFile(
      path.join(ticketDir, 'run.json'),
      JSON.stringify({ classification: ' BUG ' }),
    );
    await mkdir(path.join(ticketDir, 'attachments'));
    await writeFile(path.join(ticketDir, 'attachments', 'a.png'), '');
    await writeFile(path.join(ticketDir, 'attachments', 'a.txt'), '');
    runCodexExecMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: `x<!-- CUSTOMER_IMPACT_START -->\n\`\`\`json\n${JSON.stringify(assessment)}\n\`\`\`\n<!-- CUSTOMER_IMPACT_END -->`,
      stderr: 'token pk_secret',
    });

    const result = await evaluateTicketImpact({
      ...baseOptions,
      ticketDir,
      promptPath,
    });

    const call = runCodexExecMock.mock.calls[0][0];
    expect(call).toMatchObject({
      codexBin: 'codex',
      cwd: '/repos',
      timeoutMs: 1000,
      addDir: ticketDir,
      permissions: 'default_permissions="driva-debug-read-network"',
      model: 'gpt-x',
      imagePaths: [path.join(ticketDir, 'attachments', 'a.png')],
    });
    expect(call.env).not.toHaveProperty('GH_TOKEN');
    expect(call.prompt).toContain('"id": "T1"');
    expect(result.impact.ticket_id).toBe('T1');
    expect(result.impact.calculation.score).toEqual(expect.any(Number));
    expect(result.stderr).toBe('token [REDACTED_CLICKUP_TOKEN]');
  });

  it('usa o sandbox configurado e rejeita modo inválido', async () => {
    await writeFile(
      path.join(ticketDir, 'run.json'),
      JSON.stringify({ classification: 'bug' }),
    );
    await expect(
      evaluateTicketImpact({
        ...baseOptions,
        sandboxMode: 'open',
        ticketDir,
        promptPath,
      }),
    ).rejects.toThrow('Invalid IMPACT_CODEX_SANDBOX_MODE');
  });

  it('falha quando o Codex sai com erro ou sem marcador', async () => {
    await writeFile(
      path.join(ticketDir, 'run.json'),
      JSON.stringify({ classification: 'bug' }),
    );
    runCodexExecMock.mockResolvedValueOnce({
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: 'boom',
    });
    await expect(
      evaluateTicketImpact({ ...baseOptions, ticketDir, promptPath }),
    ).rejects.toThrow('exited with code 2: boom');

    runCodexExecMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: 'sem marcador',
      stderr: '',
    });
    await expect(
      evaluateTicketImpact({ ...baseOptions, ticketDir, promptPath }),
    ).rejects.toThrow('output marker was not found');
  });
});
