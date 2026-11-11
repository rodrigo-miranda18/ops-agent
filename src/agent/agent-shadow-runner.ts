#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeExec } from '../claude/claude.js';
import { loadDotEnv } from '../config/env.js';
import { runnerConfigFromEnv } from '../config/runner-config.js';
import { renderTicketPrompt } from '../diagnosis/diagnosis-prompt.js';
import { extractOutput } from '../diagnosis/diagnosis-output.js';
import { renderDiagnosisVectorPrompt } from '../diagnosis/vector-classification.js';
import { runnerCodexEnvironment } from '../runner/runner-codex.js';
import { runnerLogger } from '../runner/runner-logger.js';
import { compareShadow, type ShadowAction } from './agent-shadow.js';

const distDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argument(name: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  if (!value) throw new Error(`Missing --${name}`);
  return value.slice(prefix.length);
}

async function readBaseline(ticketDir: string): Promise<ShadowAction | null> {
  try {
    return JSON.parse(
      await readFile(path.join(ticketDir, 'engineering-action.json'), 'utf8'),
    ) as ShadowAction;
  } catch {
    return null;
  }
}

async function main() {
  await loadDotEnv(path.join(process.cwd(), '.env'));
  const ticketDir = path.resolve(argument('ticket-dir'));
  const outputDir = path.resolve(argument('output-dir'));
  const config = runnerConfigFromEnv({});
  await mkdir(outputDir, { recursive: true });
  const template = renderDiagnosisVectorPrompt(
    await readFile(path.join(distDir, 'prompts', 'prompt.md'), 'utf8'),
    config.diagnosisVectors,
  );
  const ticket = JSON.parse(
    await readFile(path.join(ticketDir, 'ticket.json'), 'utf8'),
  ) as {
    id: string;
    attachments?: { local_path?: string; image_context?: boolean }[];
  };
  const imagePaths = (ticket.attachments ?? []).flatMap((attachment) =>
    attachment.image_context && attachment.local_path
      ? [attachment.local_path]
      : [],
  );
  const startedAt = Date.now();
  const result = await runClaudeExec({
    claude: config.agent.claude,
    cwd: config.reposDir,
    env: runnerCodexEnvironment({ remediation: false }),
    timeoutMs: config.codexTimeoutMs,
    prompt: renderTicketPrompt(template, ticket),
    addDir: ticketDir,
    profile: 'read',
    imagePaths,
  });
  await writeFile(path.join(outputDir, 'raw-output.md'), result.stdout);
  await writeFile(path.join(outputDir, 'stderr.log'), result.stderr);
  let shadow: ShadowAction | null = null;
  let error = result.exitCode === 0 ? null : result.stderr.slice(-500);
  if (result.exitCode === 0) {
    try {
      shadow = extractOutput(result.stdout, config.diagnosisVectors)
        .engineeringAction as unknown as ShadowAction;
    } catch (parseError) {
      error = (parseError as Error).message;
    }
  }
  const comparison = {
    ...compareShadow(ticket.id, await readBaseline(ticketDir), shadow, error),
    durationMinutes: Math.round((Date.now() - startedAt) / 6_000) / 10,
    usage: result.stderr.split('\n').at(-1),
  };
  await writeFile(
    path.join(outputDir, 'comparison.json'),
    JSON.stringify(comparison, null, 2),
  );
  runnerLogger.info(`Shadow ${ticket.id}: ${JSON.stringify(comparison)}`);
}

main().catch((error: Error) => {
  runnerLogger.error(`Shadow run failed: ${error.message}`);
  process.exitCode = 1;
});
