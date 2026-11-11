import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(
  filename: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, filename);
}

export async function writeJsonAtomic(
  filename: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(filename, `${JSON.stringify(value, null, 2)}\n`);
}
