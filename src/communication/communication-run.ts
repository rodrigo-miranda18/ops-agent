import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../common/sanitize.js';
import { runnerLogger, type RunnerLogger } from '../runner/runner-logger.js';
import { writeFileAtomic, writeJsonAtomic } from '../state/atomic-write.js';
import {
  uploadSelectedImages,
  type ImageManifestEntry,
} from './communication-media.js';
import {
  parseCommunicationOutput,
  type CommunicationOutput,
} from './communication-output.js';
import type { ClickUpContext } from './communication.types.js';
import type { MediaStorage } from './media-storage.js';
import {
  extractPullRequestLinks,
  isOrganizationPullRequest,
  type PullRequestRef,
} from './pull-request-links.js';

const PROMPT_PATH = fileURLToPath(
  new URL('../prompts/communication-prompt.md', import.meta.url),
);
const MAX_CODEX_ATTEMPTS = 2;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface CommunicationCodexInput {
  prompt: string;
  imagePaths: string[];
  ghToken: string | null;
  cwd: string;
}

export interface CommunicationCodexResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommunicationRunDeps {
  collect(taskId: string): Promise<ClickUpContext>;
  readPullRequest(ref: PullRequestRef): Promise<unknown>;
  scopedToken(): Promise<string | null>;
  downloadImage(url: string, destination: string): Promise<void>;
  runCodex(input: CommunicationCodexInput): Promise<CommunicationCodexResult>;
  media?: MediaStorage | null;
  logger?: RunnerLogger;
}

export interface CommunicationRunArgs {
  communicationId: string;
  version: number;
  taskId: string;
  history: unknown[];
  artifactDir: string;
  reposDir: string;
  organization: string;
}

export async function runCommunication(
  args: CommunicationRunArgs,
  deps: CommunicationRunDeps,
): Promise<CommunicationOutput> {
  const logger = deps.logger ?? runnerLogger;
  const label = `${args.communicationId} v${args.version}`;
  const contextDir = path.join(args.artifactDir, 'context');
  const pullRequestsDir = path.join(contextDir, 'pull-requests');
  const imagesDir = path.join(args.artifactDir, 'images');
  await mkdir(pullRequestsDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });

  const context = await deps.collect(args.taskId);
  const warnings = [...context.warnings];
  await writeJsonAtomic(path.join(contextDir, 'clickup.json'), context);

  const pullRequests = extractPullRequestLinks(contextTexts(context)).filter(
    (ref) => isOrganizationPullRequest(ref, args.organization),
  );
  for (const ref of pullRequests) {
    try {
      const data = await deps.readPullRequest(ref);
      await writeJsonAtomic(
        path.join(pullRequestsDir, pullRequestFilename(ref)),
        data,
      );
    } catch (error) {
      warnings.push(
        `PR ${ref.url} indisponível: ${sanitize(errorMessage(error)).slice(0, 500)}`,
      );
    }
  }

  let ghToken: string | null = null;
  if (pullRequests.length === 0) {
    try {
      ghToken = await deps.scopedToken();
    } catch (error) {
      logger.warn(
        `Communication ${label}: scoped GitHub token failed: ${sanitize(errorMessage(error))}`,
      );
    }
    if (!ghToken)
      warnings.push(
        'Token do GitHub indisponível: a busca de PRs pelo Codex ficou sem acesso ao GitHub.',
      );
  }
  const redact = (value: unknown) => {
    const text = sanitize(value);
    return ghToken ? text.replaceAll(ghToken, '[REDACTED_GITHUB_TOKEN]') : text;
  };

  const imagePaths: string[] = [];
  const imageManifest: ImageManifestEntry[] = [];
  for (const [index, url] of context.imageUrls.entries()) {
    const destination = path.join(
      imagesDir,
      `${index + 1}${imageExtension(url)}`,
    );
    try {
      await deps.downloadImage(url, destination);
      imagePaths.push(destination);
      imageManifest.push({
        index: index + 1,
        file: path.basename(destination),
      });
    } catch (error) {
      warnings.push(
        `Imagem ${index + 1} indisponível: ${redact(errorMessage(error)).slice(0, 500)}`,
      );
    }
  }

  if (args.history.length)
    await writeJsonAtomic(path.join(contextDir, 'history.json'), args.history);
  await writeJsonAtomic(path.join(contextDir, 'warnings.json'), warnings);
  await writeJsonAtomic(path.join(contextDir, 'images.json'), imageManifest);

  const prompt = await buildPrompt(args.artifactDir, args.reposDir);
  await writeFileAtomic(path.join(args.artifactDir, 'prompt.md'), prompt);

  const logPath = path.join(args.artifactDir, 'codex.log');
  let attemptPrompt = prompt;
  for (let attempt = 1; ; attempt += 1) {
    logger.info(`Communication ${label}: running Codex (attempt ${attempt})`);
    const result = await deps.runCodex({
      prompt: attemptPrompt,
      imagePaths,
      ghToken,
      cwd: args.reposDir,
    });
    const stdout = redact(result.stdout);
    const stderr = redact(result.stderr);
    await appendFile(
      logPath,
      `# attempt ${attempt} (exit ${result.exitCode})\n## stderr\n${stderr}\n## stdout\n${stdout}\n`,
      { mode: 0o600 },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Codex exited with code ${result.exitCode}: ${stderr.slice(-2000)}`,
      );
    let output: CommunicationOutput;
    try {
      output = parseCommunicationOutput(parseJsonObject(stdout));
    } catch (error) {
      const reason = errorMessage(error);
      if (attempt >= MAX_CODEX_ATTEMPTS)
        throw new Error(`Invalid communication output: ${reason}`, {
          cause: error,
        });
      logger.warn(
        `Communication ${label}: invalid output, retrying: ${reason}`,
      );
      attemptPrompt = `${prompt}\n\nA resposta anterior foi rejeitada (${reason}). Responda apenas com o objeto JSON no formato da seção Saída.\n`;
      continue;
    }
    await writeJsonAtomic(path.join(args.artifactDir, 'output.json'), output);
    logger.info(`Communication ${label}: output ${output.status}`);
    if (deps.media && output.status === 'READY') {
      const uploaded = await uploadSelectedImages(
        deps.media,
        output.images,
        imageManifest,
        imagesDir,
      );
      await writeJsonAtomic(
        path.join(args.artifactDir, 'media.json'),
        uploaded.media,
      );
      if (uploaded.warnings.length)
        await writeJsonAtomic(path.join(contextDir, 'warnings.json'), [
          ...warnings,
          ...uploaded.warnings,
        ]);
      logger.info(
        `Communication ${label}: ${uploaded.media.length} image(s) uploaded`,
      );
    }
    return output;
  }
}

function contextTexts(context: ClickUpContext): string[] {
  return [
    context.task.description,
    ...context.subtasks.map((subtask) => subtask.description),
    ...context.comments.map((comment) => comment.text),
  ];
}

function pullRequestFilename(ref: PullRequestRef): string {
  return `${ref.owner}-${ref.repo}-${ref.number}.json`.replace(
    /[^A-Za-z0-9_.-]/g,
    '_',
  );
}

function imageExtension(url: string): string {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) ? extension : '.png';
  } catch {
    return '.png';
  }
}

async function buildPrompt(artifactDir: string, reposDir: string) {
  const template = await readFile(PROMPT_PATH, 'utf8');
  return `${template.trimEnd()}\n\n## Diretórios\n\n- Diretório desta execução (contém \`context/\`): \`${artifactDir}\`\n- Raiz dos repositórios da Driva: \`${reposDir}\`\n`;
}

function parseJsonObject(stdout: string): unknown {
  const text = stdout
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
      throw new Error('Codex output contains no JSON object');
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
