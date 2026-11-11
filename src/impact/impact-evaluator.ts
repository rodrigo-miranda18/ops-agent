import { runAgentExec } from '../agent/agent-exec.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CODEX_READ_NETWORK_PERMISSIONS,
  CODEX_SANDBOX_MODES,
  codexSandboxPermissions,
  type CodexSandboxMode,
} from '../codex/codex.js';
import { sanitize } from '../common/sanitize.js';
import { codexEnvironment } from '../config/env.js';
import type { ImpactCodexConfig } from '../config/impact-config.js';
import {
  calculateCustomerImpact,
  type CustomerImpact,
} from './customer-impact.js';

type JsonObject = Record<string, unknown>;

export interface ImpactTicket extends JsonObject {
  id?: unknown;
  custom_id?: unknown;
  name?: unknown;
}

export interface ImpactContext {
  ticket: ImpactTicket;
  existing_run: unknown;
  technical_diagnosis: string | null;
  cs_comment: string | null;
  engineering_action: unknown;
  remediation: unknown;
}

export interface TicketImpact extends CustomerImpact {
  ticket_id: string;
  evaluated_at: string;
}

export interface TicketImpactEvaluation {
  impact: TicketImpact;
  stdout: string;
  stderr: string;
  context: ImpactContext;
}

export interface EvaluateTicketImpactOptions extends ImpactCodexConfig {
  ticketDir: string;
  promptPath: string;
}

export async function evaluateTicketImpact(
  options: EvaluateTicketImpactOptions,
): Promise<TicketImpactEvaluation> {
  const ticketDir = path.resolve(options.ticketDir);
  const promptTemplate = await readFile(options.promptPath, 'utf8');
  const context = await loadImpactContext(ticketDir);
  if (
    normalizeClassification(runClassification(context.existing_run)) !== 'bug'
  ) {
    throw new Error('Customer impact is only available for confirmed bugs');
  }
  const prompt = promptTemplate.replace(
    '{{IMPACT_CONTEXT_JSON}}',
    JSON.stringify(context, null, 2),
  );
  const imagePaths = await findImages(path.join(ticketDir, 'attachments'));
  const result = await runCodex(options, ticketDir, prompt, imagePaths);
  if (result.exitCode !== 0)
    throw new Error(
      `Impact evaluator exited with code ${result.exitCode}: ${result.stderr.slice(-2000)}`,
    );
  const match = result.stdout.match(
    /<!--\s*CUSTOMER_IMPACT_START\s*-->([\s\S]*?)<!--\s*CUSTOMER_IMPACT_END\s*-->/i,
  );
  if (!match) throw new Error('Impact evaluator output marker was not found');
  const assessment = JSON.parse(
    match[1].trim().replace(/^```json\s*|\s*```$/g, ''),
  ) as unknown;
  const impact = calculateCustomerImpact(assessment);
  return {
    impact: {
      ticket_id: String(context.ticket.id),
      evaluated_at: new Date().toISOString(),
      ...impact,
    },
    stdout: result.stdout,
    stderr: result.stderr,
    context,
  };
}

export function normalizeClassification(value: unknown) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

export function runClassification(run: unknown): unknown {
  return isJsonObject(run) ? run.classification : undefined;
}

export async function loadImpactContext(
  ticketDir: string,
): Promise<ImpactContext> {
  return {
    ticket: await loadImpactTicket(ticketDir),
    existing_run: await readOptionalJson(path.join(ticketDir, 'run.json')),
    technical_diagnosis: await readText(path.join(ticketDir, 'diagnosis.md')),
    cs_comment: await readText(path.join(ticketDir, 'cs-comment.md')),
    engineering_action: await readOptionalJson(
      path.join(ticketDir, 'engineering-action.json'),
    ),
    remediation: await readOptionalJson(
      path.join(ticketDir, 'remediation.json'),
    ),
  };
}

export async function loadImpactTicket(
  ticketDir: string,
): Promise<ImpactTicket> {
  const ticket = await readJson(path.join(ticketDir, 'ticket.json'));
  if (!isJsonObject(ticket)) throw new Error('ticket.json must be an object');
  return ticket;
}

async function runCodex(
  options: ImpactCodexConfig,
  ticketDir: string,
  prompt: string,
  imagePaths: readonly string[],
) {
  const result = await runAgentExec({
    surface: 'impact',
    profile: 'read',
    agent: options.agent,
    codexBin: options.codexBin || 'codex',
    cwd: options.reposDir,
    env: codexEnvironment(),
    timeoutMs: options.timeoutMs || 900_000,
    prompt,
    addDir: ticketDir,
    permissions: options.sandboxMode
      ? codexSandboxPermissions(sandboxMode(options.sandboxMode))
      : CODEX_READ_NETWORK_PERMISSIONS,
    model: options.model,
    imagePaths,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: sanitize(result.stderr),
  };
}

function sandboxMode(value: string): CodexSandboxMode {
  if (!isCodexSandboxMode(value)) {
    throw new Error('Invalid IMPACT_CODEX_SANDBOX_MODE');
  }
  return value;
}

function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return (CODEX_SANDBOX_MODES as readonly string[]).includes(value);
}

async function findImages(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() && /\.(png|jpe?g|gif|webp)$/i.test(entry.name),
      )
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, 'utf8')) as unknown;
}

export async function readOptionalJson(filename: string): Promise<unknown> {
  try {
    return await readJson(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readText(filename: string) {
  try {
    return (await readFile(filename, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
