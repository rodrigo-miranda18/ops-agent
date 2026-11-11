#!/usr/bin/env node

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sanitize as sanitizeValue } from '../common/sanitize.js';
import { loadDotEnv } from '../config/env.js';
import { impactCodexConfigFromEnv } from '../config/impact-config.js';
import { runnerLogger } from '../runner/runner-logger.js';
import {
  parseImpactArgs,
  printImpactHelp,
  type ImpactRunnerArgs,
} from './impact-args.js';
import {
  evaluateTicketImpact,
  loadImpactTicket,
  normalizeClassification,
  readOptionalJson,
  runClassification,
  type ImpactTicket,
} from './impact-evaluator.js';
import { persistCurrentImpact, writeJsonAtomic } from './impact-persistence.js';
import {
  buildImpactSummary,
  impactEvaluationsToCsv,
  type ImpactEvaluation,
  type ImpactReportImpact,
} from './impact-report.js';

const impactDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(path.dirname(impactDir));

interface SkippedImpact {
  ticket_id: string;
  classification: unknown;
  reason: string;
}

interface ImpactFailure {
  ticket_id: string;
  error: string;
}

type ImpactOutcome = ImpactEvaluation | { skipped: SkippedImpact };

async function discoverTicketIds(source: string) {
  const entries = await readdir(source, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(source, entry.name, 'ticket.json'));
      ids.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return ids.sort();
}

async function evaluateOne(
  args: ImpactRunnerArgs,
  ticketId: string,
): Promise<ImpactOutcome> {
  const safeTicketId = ticketId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safeTicketId || safeTicketId !== ticketId)
    throw new Error(`Unsafe ticket ID: ${ticketId}`);
  const ticketDir = path.join(args.source, safeTicketId);
  const outputTicketDir = args.output
    ? path.join(args.output, 'tickets', safeTicketId)
    : ticketDir;
  const outputPath = path.join(outputTicketDir, 'customer-impact.json');
  const context = await loadStoredContext(ticketDir);
  if (normalizeClassification(context.classification) !== 'bug') {
    await removeIfExists(outputPath);
    await removeIfExists(path.join(outputTicketDir, 'error.json'));
    const skipped: SkippedImpact = {
      ticket_id: ticketId,
      classification: context.classification,
      reason: 'Customer impact is only calculated for confirmed bugs',
    };
    runnerLogger.info(
      `Skipping ${ticketId}; classification=${String(context.classification || 'unknown')} is not a confirmed bug`,
    );
    return { skipped };
  }
  if (!args.force && args.output) {
    try {
      const impact = JSON.parse(
        await readFile(outputPath, 'utf8'),
      ) as ImpactReportImpact;
      runnerLogger.info(
        `Skipping ${ticketId}; historical impact already exists`,
      );
      return {
        ticket: context.ticket,
        classification: classificationLabel(context.classification),
        impact,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  runnerLogger.info(`Evaluating customer impact for ${ticketId}`);
  const evaluation = await evaluateTicketImpact({
    ticketDir,
    promptPath: path.join(impactDir, 'impact-prompt.md'),
    ...impactCodexConfigFromEnv(projectDir),
  });

  if (args.output) {
    await mkdir(outputTicketDir, { recursive: true });
    await writeJsonAtomic(outputPath, evaluation.impact);
  } else {
    await persistCurrentImpact(ticketDir, evaluation.impact);
  }
  await writeFile(
    path.join(outputTicketDir, 'raw-output.md'),
    evaluation.stdout,
    { mode: 0o600 },
  );
  if (evaluation.stderr)
    await writeFile(
      path.join(outputTicketDir, 'stderr.log'),
      `${evaluation.stderr.trimEnd()}\n`,
      { mode: 0o600 },
    );
  await removeIfExists(path.join(outputTicketDir, 'error.json'));

  const classification = classificationLabel(
    runClassification(evaluation.context.existing_run),
  );
  runnerLogger.info(
    `DRIVA_IMPACT_READY:${ticketId}:${evaluation.impact.calculation.score}`,
  );
  return {
    ticket: evaluation.context.ticket,
    classification,
    impact: evaluation.impact,
  };
}

function classificationLabel(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}

async function removeIfExists(filename: string) {
  try {
    await unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function loadStoredContext(
  ticketDir: string,
): Promise<{ ticket: ImpactTicket; classification: unknown }> {
  const ticket = await loadImpactTicket(ticketDir);
  const run = await readOptionalJson(path.join(ticketDir, 'run.json'));
  return { ticket, classification: runClassification(run) || null };
}

async function runBatch<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  await loadDotEnv(path.join(projectDir, '.env'));
  const args = parseImpactArgs(process.argv.slice(2), projectDir);
  if (args.help) return printImpactHelp();
  const ticketIds =
    args.all || !args.ticketId
      ? await discoverTicketIds(args.source)
      : [args.ticketId];
  if (!ticketIds.length)
    throw new Error(`No ticket artifacts found under ${args.source}`);
  const output = args.output;
  if (output) await mkdir(output, { recursive: true });

  const errors: ImpactFailure[] = [];
  const outcomes = (
    await runBatch(ticketIds, args.concurrency, async (ticketId) => {
      try {
        return await evaluateOne(args, ticketId);
      } catch (error) {
        const failure: ImpactFailure = {
          ticket_id: ticketId,
          error: sanitize((error as Error).message),
        };
        errors.push(failure);
        runnerLogger.error(
          `Impact evaluation failed for ${ticketId}: ${failure.error}`,
        );
        if (output)
          await writeJsonAtomic(
            path.join(output, 'tickets', ticketId, 'error.json'),
            failure,
          );
        return null;
      }
    })
  ).filter((outcome): outcome is ImpactOutcome => outcome !== null);
  const evaluations = outcomes.filter(
    (outcome): outcome is ImpactEvaluation => 'impact' in outcome,
  );
  const skipped = outcomes.flatMap((outcome) =>
    'skipped' in outcome ? [outcome.skipped] : [],
  );

  if (output) {
    await writeJsonAtomic(
      path.join(output, 'summary.json'),
      buildImpactSummary(evaluations, errors, skipped),
    );
    await writeFile(
      path.join(output, 'customer-impact.csv'),
      impactEvaluationsToCsv(evaluations),
      { mode: 0o600 },
    );
  }
  runnerLogger.info(
    `Impact evaluation complete: ${evaluations.length} succeeded; ${skipped.length} skipped; ${errors.length} failed`,
  );
  if (errors.length) process.exitCode = 1;
}

function sanitize(value: unknown) {
  return sanitizeValue(value).slice(-4000);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: Error) => {
    runnerLogger.error(`Impact runner failed: ${sanitize(error.message)}`);
    process.exitCode = 1;
  });
