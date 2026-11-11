import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../config/runtime-config.js';
import { StateService } from './state.service.js';

describe('StateService', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'state-service-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('preserves updates from separate service instances sharing a state directory', async () => {
    const runtime = { stateDir } as RuntimeConfig;
    const first = new StateService(runtime, 'nest:first');
    const second = new StateService(runtime, 'nest:second');

    await Promise.all([
      first.update<Record<string, unknown>>('shared.json', async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state.first = true;
      }),
      second.update<Record<string, unknown>>('shared.json', (state) => {
        state.second = true;
      }),
    ]);

    await expect(first.read('shared.json')).resolves.toEqual({
      first: true,
      second: true,
    });
  });
});
