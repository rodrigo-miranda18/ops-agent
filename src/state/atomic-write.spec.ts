import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeJsonAtomic } from './atomic-write.js';

describe('atomic write', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'atomic-write-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('cria diretórios, grava com modo 0600 e não deixa temporário', async () => {
    const filename = path.join(directory, 'nested', 'secret.env');
    await writeFileAtomic(filename, 'KEY=value\n');

    expect(await readFile(filename, 'utf8')).toBe('KEY=value\n');
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(filename))).toEqual(['secret.env']);
  });

  it('grava JSON indentado com quebra de linha final e substitui o anterior', async () => {
    const filename = path.join(directory, 'state.json');
    await writeJsonAtomic(filename, { old: true });
    await writeJsonAtomic(filename, { a: 1 });

    expect(await readFile(filename, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });
});
