import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  downloadAttachments,
  fetchTask,
  synchronizeDiagnosedVector as synchronizeClickUpVector,
  type RunnerClickUpConfig,
} from '../clickup/clickup-api.js';
import { normalizeTicket, toIso } from '../clickup/clickup-task.js';
import type {
  ClickUpTask,
  TicketComment,
  TicketFields,
} from '../clickup/clickup.types.js';
import { sanitize } from '../common/sanitize.js';
import type { RunnerConfig } from '../config/runner-config.js';
import type { RepositorySyncInfo } from '../git/repository-access.js';
import type { CustomerImpact } from '../impact/customer-impact.js';
import { persistCurrentImpact } from '../impact/impact-persistence.js';
import { linkIncidentPullRequests } from '../incidents/incident-issues.js';
import { remediateTicket } from '../remediation/ticket-remediation.js';
import type { RunnerArgs } from '../runner/runner-args.js';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';
import { runCodex } from '../runner/runner-codex.js';
import { runnerLogger } from '../runner/runner-logger.js';
import { resultsDir, stateFile } from '../runner/runner-paths.js';
import { writeJsonAtomic } from '../state/atomic-write.js';
import { updateJsonFileLocked } from '../state/locked-json-update.js';
import { createInstanceId } from '../state/owner-identity.js';
import type { OwnedLockOwner } from '../state/owned-lock.js';
import {
  removeIfExists,
  ticketResultsDir,
  updateRunArtifact,
  writeStderrArtifact,
  writeTextArtifact,
} from './diagnosis-artifacts.js';
import {
  extractOutput,
  type DiagnosisOutput,
  type EngineeringAction,
} from './diagnosis-output.js';
import { renderTicketPrompt } from './diagnosis-prompt.js';

export type TicketProcessingConfig = RunnerConfig &
  Pick<RunnerClickUpConfig, 'token' | 'listId'>;

export type ProcessedTickets = Record<string, unknown>;

interface StoredCustomerImpact {
  currentPath: string;
  historyPath: string;
  snapshot: CustomerImpact;
}

type ProcessedTicket = ReturnType<typeof normalizeTicket> & {
  clickup_vectors_before_diagnosis?: string[];
};

async function synchronizeDiagnosedVector(
  config: TicketProcessingConfig,
  taskId: string,
  diagnosedVector: string,
): Promise<boolean> {
  const { updated, previousVectors } = await synchronizeClickUpVector(
    config,
    taskId,
    diagnosedVector,
  );
  if (updated)
    runnerLogger.info(
      `Updated ClickUp vector for ${taskId}: ${previousVectors.join(', ') || '(empty)'} -> ${diagnosedVector}`,
    );
  return updated;
}

export async function readProcessed(): Promise<ProcessedTickets> {
  try {
    const data = JSON.parse(await readFile(stateFile, 'utf8')) as unknown;
    return data && typeof data === 'object' ? (data as ProcessedTickets) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `Cannot read state/processed.json: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

function createRunnerOwner(): OwnedLockOwner {
  const startedAt = new Date().toISOString();
  return {
    instanceId: createInstanceId('runner'),
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
  };
}

const fallbackRunnerOwner = createRunnerOwner();

export async function markProcessed(
  ticket: Pick<ProcessedTicket, 'id' | 'updated_at'>,
  processedAt: string,
  owner: OwnedLockOwner = fallbackRunnerOwner,
): Promise<void> {
  await updateJsonFileLocked<ProcessedTickets>(
    stateFile,
    owner,
    (processed) => {
      processed[versionKey(ticket)] = {
        ticket_id: ticket.id,
        updated_at: ticket.updated_at,
        processed_at: processedAt,
      };
    },
  );
}

function versionKey(ticket: Pick<ProcessedTicket, 'id' | 'updated_at'>) {
  return `${ticket.id}:${ticket.updated_at}`;
}

export function isProcessedTicketVersion(
  processed: ProcessedTickets,
  task: Pick<ClickUpTask, 'id' | 'date_updated'>,
): boolean {
  const updatedAt = toIso(task.date_updated);
  return Boolean(updatedAt && processed[`${task.id}:${updatedAt}`]);
}

function notifyTicketDiagnosis(ticketId: string): void {
  process.send?.({ type: 'ticket-diagnosis-ready', ticketId });
}

async function completeTicketRemediation(
  config: TicketProcessingConfig,
  ticketDir: string,
  ticket: ProcessedTicket,
  action: EngineeringAction,
  args: RunnerArgs,
  dependencies: RunnerDependencies,
  owner: OwnedLockOwner,
  processedAt: string,
) {
  const remediation = await remediateTicket(
    config,
    ticketDir,
    ticket,
    action,
    args.remediation,
    dependencies,
  );
  await linkIncidentPullRequests(
    config,
    ticket,
    remediation,
    dependencies.github,
  );
  await writeJsonAtomic(path.join(ticketDir, 'remediation.json'), remediation);
  await updateRunArtifact(ticketDir, {
    remediation_mode: args.remediation,
    remediation_status: remediation.status,
    notify: args.notify,
    status: 'success',
    finished_at: new Date().toISOString(),
  });
  await markProcessed(ticket, processedAt, owner);
}

export async function resumeTicketAfterDiagnosis(
  config: TicketProcessingConfig,
  ticketId: string,
  args: RunnerArgs,
  dependencies: RunnerDependencies,
  owner: OwnedLockOwner,
) {
  const ticketDir = ticketResultsDir(resultsDir, ticketId);
  const ticket = JSON.parse(
    await readFile(path.join(ticketDir, 'ticket.json'), 'utf8'),
  ) as ProcessedTicket;
  const action = JSON.parse(
    await readFile(path.join(ticketDir, 'engineering-action.json'), 'utf8'),
  ) as EngineeringAction;
  if (args.notify) notifyTicketDiagnosis(ticket.id);
  await completeTicketRemediation(
    config,
    ticketDir,
    ticket,
    action,
    args,
    dependencies,
    owner,
    new Date().toISOString(),
  );
}

export async function processTicket(
  config: TicketProcessingConfig,
  task: ClickUpTask,
  comments: TicketComment[],
  matchedFields: Partial<TicketFields>,
  promptTemplate: string,
  args: RunnerArgs,
  dependencies: RunnerDependencies,
  repositorySync: RepositorySyncInfo,
  owner: OwnedLockOwner,
): Promise<void> {
  const ticket: ProcessedTicket = normalizeTicket(
    task,
    comments,
    matchedFields,
  );
  const ticketDir = ticketResultsDir(resultsDir, ticket.id);
  const startedAt = new Date().toISOString();
  await mkdir(ticketDir, { recursive: true });
  ticket.attachments = await downloadAttachments(config, task, ticketDir);
  await writeJsonAtomic(path.join(ticketDir, 'ticket.json'), ticket);

  const imagePaths = ticket.attachments
    .filter((attachment) => attachment.image_context && attachment.local_path)
    .map((attachment) => attachment.local_path as string);
  const downloadedCount = ticket.attachments.filter(
    (attachment) => attachment.status === 'downloaded',
  ).length;
  runnerLogger.info(
    `Attachments for ${ticket.id}: ${downloadedCount}/${ticket.attachments.length} downloaded; ${imagePaths.length} images added to Codex context`,
  );
  const result = await runCodex(
    config,
    renderTicketPrompt(promptTemplate, ticket),
    ticketDir,
    imagePaths,
  );
  const finishedAt = new Date().toISOString();
  const diagnosisPath = path.join(ticketDir, 'diagnosis.md');
  const csCommentPath = path.join(ticketDir, 'cs-comment.md');
  const rawOutputPath = path.join(ticketDir, 'raw-output.md');
  const stderrPath = path.join(ticketDir, 'codex-stderr.log');
  let storedCustomerImpact: StoredCustomerImpact | null = null;
  let output: DiagnosisOutput | null = null;
  let outputError: string | null = null;
  if (result.stdout) await writeTextArtifact(rawOutputPath, result.stdout);
  else await removeIfExists(rawOutputPath);
  if (result.stderr) await writeStderrArtifact(stderrPath, result.stderr);
  else await removeIfExists(stderrPath);
  if (result.exitCode === 0) {
    try {
      output = extractOutput(result.stdout, config.diagnosisVectors);
      ticket.clickup_vectors_before_diagnosis = [...ticket.vectors];
      ticket.vectors = [output.vector];
      await writeTextArtifact(diagnosisPath, `${output.technicalDiagnosis}\n`);
      await writeTextArtifact(csCommentPath, `${output.csComment}\n`);
      if (output.customerImpact) {
        storedCustomerImpact = await persistCurrentImpact(ticketDir, {
          ticket_id: ticket.id,
          evaluated_at: finishedAt,
          ...output.customerImpact,
        });
      } else {
        await removeIfExists(path.join(ticketDir, 'customer-impact.json'));
      }
      await writeJsonAtomic(
        path.join(ticketDir, 'engineering-action.json'),
        output.engineeringAction,
      );
    } catch (error) {
      outputError = (error as Error).message;
    }
  }
  let success = result.exitCode === 0 && output !== null;

  let vectorUpdatedInClickUp = false;
  if (success && output) {
    try {
      vectorUpdatedInClickUp = await synchronizeDiagnosedVector(
        config,
        String(task.id),
        output.vector,
      );
    } catch (error) {
      outputError = `Could not synchronize diagnosed vector with ClickUp: ${(error as Error).message}`;
      success = false;
    }
  }

  const refreshedTask = await fetchTask(config, ticket.id);
  ticket.updated_at = toIso(refreshedTask.date_updated) || ticket.updated_at;
  await writeJsonAtomic(path.join(ticketDir, 'ticket.json'), ticket);

  await writeJsonAtomic(path.join(ticketDir, 'run.json'), {
    ticket_id: ticket.id,
    updated_at: ticket.updated_at,
    started_at: startedAt,
    finished_at: finishedAt,
    status: success ? 'diagnosed' : 'error',
    notification_version: 2,
    notify: args.notify,
    google_chat_space: args.googleChatSpace,
    google_chat_thread: args.googleChatThread,
    remediation_mode: args.remediation,
    remediation_status: success ? 'pending' : null,
    repository_sync: repositorySync,
    exit_code: result.exitCode,
    signal: result.signal,
    classification: output?.classification || null,
    diagnosed_vector: output?.vector || null,
    vector_updated_in_clickup: vectorUpdatedInClickUp,
    customer_impact_path: storedCustomerImpact?.currentPath || null,
    customer_impact_history_path: storedCustomerImpact?.historyPath || null,
    customer_impact_score:
      storedCustomerImpact?.snapshot.calculation.score ?? null,
    customer_impact_band:
      storedCustomerImpact?.snapshot.calculation.band.code ?? null,
    customer_impact_confidence:
      storedCustomerImpact?.snapshot.confidence ?? null,
    customer_impact_rubric_version:
      storedCustomerImpact?.snapshot.rubric_version ?? null,
    diagnosis_path: output ? diagnosisPath : null,
    cs_comment_path: output ? csCommentPath : null,
    raw_output_path: result.stdout ? rawOutputPath : null,
    stderr_path: result.stderr ? stderrPath : null,
    stderr_bytes: Buffer.byteLength(result.stderr || '', 'utf8'),
    stderr_excerpt: result.stderr ? result.stderr.slice(-4000) : null,
    attachments_downloaded: ticket.attachments.filter(
      (attachment) => attachment.status === 'downloaded',
    ).length,
    attachment_images_provided: imagePaths.length,
    attachment_errors: ticket.attachments
      .filter((attachment) => attachment.status === 'error' || attachment.error)
      .map((attachment) => ({
        filename: attachment.filename,
        error: attachment.error,
      })),
    error: success
      ? null
      : sanitize(
          outputError ||
            result.stderr ||
            'Codex exited without a complete diagnosis',
        ).slice(-4000),
  });

  if (!success || !output)
    throw new Error(
      outputError ||
        `Codex failed for ${ticket.id} with exit code ${result.exitCode}`,
    );
  if (args.notify) notifyTicketDiagnosis(ticket.id);
  await completeTicketRemediation(
    config,
    ticketDir,
    ticket,
    output.engineeringAction,
    args,
    dependencies,
    owner,
    finishedAt,
  );
}
