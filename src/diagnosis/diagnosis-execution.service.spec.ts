import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleChatNotificationsService } from '../google-chat/google-chat-notifications.service.js';
import type { StateService } from '../state/state.service.js';
import { appConfigFromEnv } from '../config/app-config.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { DiagnosisExecutionService } from './diagnosis-execution.service.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
  connected = true;
  send = vi.fn();
  kill = vi.fn(() => true);
}

class FakeState {
  files: Record<string, Record<string, unknown>> = {};

  read(name: string) {
    return Promise.resolve(structuredClone(this.files[name] || {}));
  }

  update(name: string, mutate: (state: Record<string, unknown>) => void) {
    const state = this.files[name] || {};
    mutate(state);
    this.files[name] = state;
    return Promise.resolve(state);
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(concurrency = '2') {
  const child = new FakeChild();
  spawnMock.mockReturnValue(child);
  const state = new FakeState();
  const googleChat = {
    notifyDiagnosis: vi.fn(() => Promise.resolve()),
    notifySuccessfulRuns: vi.fn(() => Promise.resolve()),
  };
  const service = new DiagnosisExecutionService(
    state as unknown as StateService,
    googleChat as unknown as GoogleChatNotificationsService,
    appConfigFromEnv({ DIAGNOSIS_EXECUTION_CONCURRENCY: concurrency }),
    runtimeConfig({}, '/app'),
    'test-instance',
  );
  return { child, state, googleChat, service };
}

async function started() {
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
}

function runStatus(state: FakeState, runId: string) {
  const runs = state.files['diagnosis-runs.json'] as Record<
    string,
    { status: string }
  >;
  return runs[runId].status;
}

describe('DiagnosisExecutionService runner IPC', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('spawns the runner with an IPC channel', async () => {
    const { child, service } = setup();
    const { completion } = await service.enqueue({
      source: 'manual',
      ticketId: 'abc',
    });
    await started();
    child.emit('close', 0);
    await completion;

    const [, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { stdio: unknown[] },
    ];
    expect(args).toContain('--ticket-id=abc');
    expect(args).toContain('--owner-instance-id=test-instance');
    expect(args).toContain('--notify');
    expect(options.stdio).toContain('ipc');
  });

  it('notifies ticket diagnoses in order and waits for them before completing', async () => {
    const { child, state, googleChat, service } = setup();
    const first = deferred();
    googleChat.notifyDiagnosis
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve());
    const { runId, completion } = await service.enqueue({ source: 'cron' });
    await started();

    child.emit('message', { type: 'ticket-diagnosis-ready', ticketId: 't1' });
    child.emit('message', { type: 'ticket-diagnosis-ready', ticketId: 't2' });
    child.emit('close', 0);
    await vi.waitFor(() =>
      expect(googleChat.notifyDiagnosis).toHaveBeenCalledTimes(1),
    );
    expect(googleChat.notifyDiagnosis).toHaveBeenCalledWith('t1');
    expect(runStatus(state, runId)).toBe('running');

    first.resolve();
    await completion;

    expect(googleChat.notifyDiagnosis.mock.calls).toEqual([['t1'], ['t2']]);
    expect(runStatus(state, runId)).toBe('completed');
  });

  it('ignores ticket diagnoses when notifications are disabled', async () => {
    const { child, googleChat, service } = setup();
    const { completion } = await service.enqueue({
      source: 'manual',
      notify: false,
    });
    await started();

    child.emit('message', { type: 'ticket-diagnosis-ready', ticketId: 't1' });
    child.emit('close', 0);
    await completion;

    expect(googleChat.notifyDiagnosis).not.toHaveBeenCalled();
    expect(googleChat.notifySuccessfulRuns).not.toHaveBeenCalled();
  });

  it('logs a failed ticket notification without failing the run', async () => {
    const { child, state, googleChat, service } = setup();
    googleChat.notifyDiagnosis.mockRejectedValueOnce(new Error('chat down'));
    const { runId, completion } = await service.enqueue({ source: 'cron' });
    await started();

    child.emit('message', { type: 'ticket-diagnosis-ready', ticketId: 't1' });
    child.emit('close', 0);
    await completion;

    expect(runStatus(state, runId)).toBe('completed');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Diagnosis notification failed for t1: chat down',
    );
  });

  it('acknowledges incident diagnoses after notifying', async () => {
    const { child, googleChat, service } = setup();
    const { completion } = await service.enqueue({
      source: 'grafana',
      incidentId: 'grafana-1',
    });
    await started();

    child.emit('message', {
      type: 'incident-diagnosis-ready',
      incidentId: 'grafana-1',
    });
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith({ incidentId: 'grafana-1' }),
    );
    expect(googleChat.notifyDiagnosis).toHaveBeenCalledWith('grafana-1');

    child.emit('close', 0);
    await completion;
  });

  it('acknowledges incident notification failures with the error', async () => {
    const { child, googleChat, service } = setup();
    googleChat.notifyDiagnosis.mockRejectedValueOnce(new Error('no space'));
    const { completion } = await service.enqueue({
      source: 'grafana',
      incidentId: 'grafana-1',
      notify: false,
    });
    await started();

    child.emit('message', {
      type: 'incident-diagnosis-ready',
      incidentId: 'grafana-1',
    });
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith({
        incidentId: 'grafana-1',
        error: 'no space',
      }),
    );

    child.emit('close', 0);
    await completion;
  });

  it('does not reply once the runner has disconnected', async () => {
    const { child, googleChat, service } = setup();
    const { completion } = await service.enqueue({ source: 'grafana' });
    await started();

    child.connected = false;
    child.emit('message', {
      type: 'incident-diagnosis-ready',
      incidentId: 'grafana-1',
    });
    await vi.waitFor(() =>
      expect(googleChat.notifyDiagnosis).toHaveBeenCalledTimes(1),
    );
    child.emit('close', 0);
    await completion;

    expect(child.send).not.toHaveBeenCalled();
  });

  it('ignores unknown and malformed messages', async () => {
    const { child, googleChat, service } = setup();
    const { completion } = await service.enqueue({ source: 'cron' });
    await started();

    child.emit('message', { type: 'something-else', ticketId: 't1' });
    child.emit('message', { type: 'ticket-diagnosis-ready' });
    child.emit('message', 'DRIVA_DIAGNOSIS_READY:t1');
    child.emit('close', 0);
    await completion;

    expect(googleChat.notifyDiagnosis).not.toHaveBeenCalled();
  });

  it('serializes the same ticket while another ticket uses the free slot', async () => {
    const { service } = setup();
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });

    const first = await service.enqueue({ source: 'manual', ticketId: 'one' });
    const duplicate = await service.enqueue({
      source: 'manual',
      ticketId: 'one',
    });
    const other = await service.enqueue({ source: 'manual', ticketId: 'two' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      expect.arrayContaining(['--ticket-id=one']),
      expect.arrayContaining(['--ticket-id=two']),
    ]);

    children[1]?.emit('close', 0);
    await other.completion;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    children[0]?.emit('close', 0);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
    children[2]?.emit('close', 0);
    await Promise.all([first.completion, duplicate.completion]);
  });

  it('tracks active cron items from runner IPC', async () => {
    const { child, state, service } = setup();
    const { runId, completion } = await service.enqueue({ source: 'cron' });
    await started();

    child.emit('message', { type: 'item-started', key: 'ticket:42' });
    await vi.waitFor(() => {
      const runs = state.files['diagnosis-runs.json'] as Record<
        string,
        { activeItems?: string[] }
      >;
      expect(runs[runId].activeItems).toEqual(['ticket:42']);
    });
    child.emit('message', { type: 'item-finished', key: 'ticket:42' });
    await vi.waitFor(() => {
      const runs = state.files['diagnosis-runs.json'] as Record<
        string,
        { activeItems?: string[] }
      >;
      expect(runs[runId].activeItems).toEqual([]);
    });

    child.emit('close', 0);
    await completion;
  });

  it('interrupts running children on shutdown without starting queued work', async () => {
    const { child, state, service } = setup('1');
    const first = await service.enqueue({ source: 'manual', ticketId: 'one' });
    const second = await service.enqueue({ source: 'manual', ticketId: 'two' });
    await started();

    await service.onApplicationShutdown();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runStatus(state, first.runId)).toBe('interrupted');
    expect(runStatus(state, second.runId)).toBe('queued');
    child.emit('close', 0);
    await first.completion;
    expect(runStatus(state, first.runId)).toBe('interrupted');
    void second.completion;
  });

  it('observes a failed incident completion even when the webhook does not await it', async () => {
    const { child, state, service } = setup('1');
    const failed = await service.enqueue({
      source: 'grafana',
      incidentId: 'grafana-1',
    });
    await started();

    child.emit('close', 1);
    await vi.waitFor(() =>
      expect(runStatus(state, failed.runId)).toBe('failed'),
    );
    await expect(failed.completion).rejects.toThrow(
      'Diagnosis runner exited with code 1',
    );
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      `Diagnosis run ${failed.runId} failed: Diagnosis runner exited with code 1`,
    );

    const next = await service.enqueue({ source: 'manual', ticketId: 'next' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    child.emit('close', 0);
    await next.completion;
    expect(runStatus(state, next.runId)).toBe('completed');
  });

  it('marks the run as failed when the runner exits with an error', async () => {
    const { child, state, service } = setup();
    const { runId, completion } = await service.enqueue({ source: 'cron' });
    await started();

    child.emit('close', 2);

    await expect(completion).rejects.toThrow(
      'Diagnosis runner exited with code 2',
    );
    expect(runStatus(state, runId)).toBe('failed');
  });
});
