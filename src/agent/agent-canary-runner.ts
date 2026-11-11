#!/usr/bin/env node

import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from '../config/env.js';
import { runnerConfigFromEnv } from '../config/runner-config.js';
import { extractOutput } from '../diagnosis/diagnosis-output.js';
import { runRemediation } from '../remediation/remediation-run.js';
import { createRunnerDependencies } from '../runner/runner-dependencies.js';
import { runnerLogger } from '../runner/runner-logger.js';

const DRAFT_INSTRUCTION =
  'Canário de migração: abra o PR obrigatoriamente como draft, com gh pr create --draft, e nunca faça merge.';

function argument(name: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  if (!value) throw new Error(`Missing --${name}`);
  return value.slice(prefix.length);
}

async function main() {
  await loadDotEnv(path.join(process.cwd(), '.env'));
  const ticketDir = path.resolve(argument('ticket-dir'));
  const shadowDir = path.resolve(argument('shadow-dir'));
  const outputDir = path.resolve(argument('output-dir'));
  const config = runnerConfigFromEnv({});
  if (config.agent.runtimes.remediation !== 'claude')
    throw new Error('Canary requires AGENT_RUNTIME_REMEDIATION=claude');
  await mkdir(path.dirname(outputDir), { recursive: true });
  await cp(ticketDir, outputDir, { recursive: true });
  const ticket = JSON.parse(
    await readFile(path.join(outputDir, 'ticket.json'), 'utf8'),
  ) as { id: string };
  const { engineeringAction } = extractOutput(
    await readFile(path.join(shadowDir, 'raw-output.md'), 'utf8'),
    config.diagnosisVectors,
  );
  const result = await runRemediation(
    config,
    outputDir,
    ticket,
    engineeringAction,
    'auto',
    { instruction: DRAFT_INSTRUCTION },
    createRunnerDependencies(config),
  );
  runnerLogger.info(`Canary ${ticket.id}: ${String(result.status)}`);
}

main().catch((error: Error) => {
  runnerLogger.error(`Canary failed: ${error.message}`);
  process.exitCode = 1;
});
