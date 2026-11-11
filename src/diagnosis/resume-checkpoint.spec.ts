import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readResumeCheckpoint } from './resume-checkpoint.js';

describe('readResumeCheckpoint', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'resume-checkpoint-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeArtifacts(run: unknown) {
    await writeFile(path.join(directory, 'run.json'), JSON.stringify(run));
    await writeFile(
      path.join(directory, 'engineering-action.json'),
      JSON.stringify({
        decision: 'CORRECTION_REQUIRED',
        confidence: 'high',
        summary: 'fix',
        reason: 'cause',
        repositories: [],
      }),
    );
    await writeFile(
      path.join(directory, 'ticket.json'),
      JSON.stringify({ id: '42' }),
    );
    await writeFile(path.join(directory, 'diagnosis.md'), 'diagnosis');
    await writeFile(path.join(directory, 'cs-comment.md'), 'comment');
  }

  it('accepts diagnosed artifacts with pending remediation', async () => {
    await writeArtifacts({
      status: 'diagnosed',
      remediation_status: 'pending',
    });

    await expect(readResumeCheckpoint(directory)).resolves.toBe(
      'diagnosis-complete',
    );
  });

  it.each([
    { status: 'success', remediation_status: 'pending' },
    { status: 'diagnosed', remediation_status: 'PR_OPENED' },
    { status: 'error', remediation_status: null },
  ])('restarts for incomplete run state %#', async (run) => {
    await writeArtifacts(run);

    await expect(readResumeCheckpoint(directory)).resolves.toBe('restart');
  });

  it('restarts when artifacts are missing or malformed', async () => {
    await expect(readResumeCheckpoint(directory)).resolves.toBe('restart');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'run.json'), '{bad');
    await expect(readResumeCheckpoint(directory)).resolves.toBe('restart');
  });
});
