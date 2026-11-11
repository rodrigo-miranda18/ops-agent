import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const runnerDir = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
export const projectDir = path.dirname(runnerDir);
export const stateDir = path.join(projectDir, 'state');
export const stateFile = path.join(stateDir, 'processed.json');
export const resultsDir = path.join(projectDir, 'results');
export const dependencyStateFile = path.join(
  projectDir,
  'state',
  'dependency-fingerprints.json',
);
export const dependencyCacheDir = path.join(
  projectDir,
  'state',
  'dependency-cache',
);
