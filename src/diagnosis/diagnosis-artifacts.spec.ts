import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readJsonArtifact,
  removeIfExists,
  ticketResultsDir,
  updateRunArtifact,
  writeStderrArtifact,
} from './diagnosis-artifacts.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'diagnosis-artifacts-'));
}

describe('ticketResultsDir', () => {
  it('sanitizes the ticket id into a single path segment', () => {
    expect(ticketResultsDir('/results', 'grafana:a/b c')).toBe(
      '/results/grafana_a_b_c',
    );
  });
});

describe('removeIfExists', () => {
  it('ignores missing files', async () => {
    const dir = await tempDir();
    await expect(
      removeIfExists(path.join(dir, 'missing.log')),
    ).resolves.toBeUndefined();
  });
});

describe('writeStderrArtifact', () => {
  it('writes trimmed stderr with a trailing newline and mode 0600', async () => {
    const file = path.join(await tempDir(), 'stderr.log');
    await writeStderrArtifact(file, 'boom\n\n');
    expect(await readFile(file, 'utf8')).toBe('boom\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('updateRunArtifact', () => {
  it('merges changes into run.json preserving existing fields', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'run.json'),
      JSON.stringify({ ticket_id: 'T1', status: 'diagnosed' }),
    );
    await updateRunArtifact(dir, { status: 'success', notify: true });
    expect(await readJsonArtifact(dir, 'run.json')).toEqual({
      ticket_id: 'T1',
      status: 'success',
      notify: true,
    });
  });
});
