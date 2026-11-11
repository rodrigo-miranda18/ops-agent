import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { writeJsonAtomic } from './impact-persistence.js';

it('concurrent atomic writes to the same file do not collide on the temporary file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atomic-write-'));
  try {
    const filename = path.join(dir, 'state.json');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeJsonAtomic(filename, { index }),
      ),
    );
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    expect(typeof stored.index).toBe('number');
    expect(await readdir(dir)).toEqual(['state.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
