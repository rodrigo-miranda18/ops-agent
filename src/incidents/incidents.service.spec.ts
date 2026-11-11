import { expect, it } from 'vitest';
import {
  IncidentsService,
  normalizeGrafanaPayload,
} from './incidents.service.js';

const alert = (changes = {}) => ({
  status: 'firing',
  fingerprint: 'abc',
  startsAt: '2026-09-15T12:00:00Z',
  labels: { alertname: '5xx', severity: 'critical' },
  annotations: {},
  ...changes,
});
function setup({ suppression = null } = {}) {
  const files = {};
  const calls = [];
  const notified = [];
  const recurrence = {
    async suppressionFor() {
      return suppression;
    },
    async announce(input) {
      notified.push(input);
    },
  };
  const state = {
    async update(name, mutate) {
      const records = (files[name] ||= {});
      mutate(records);
      return records;
    },
  };
  const executions = {
    async enqueue(options) {
      calls.push(options);
      return { runId: 'run-' + calls.length };
    },
  };
  return {
    service: new IncidentsService(state, executions, recurrence),
    calls,
    notified,
    files,
    executions,
  };
}

it('processes every alert in a grouped notification', async () => {
  // Arrange
  const { service, calls } = setup();
  // Act
  const response = await service.ingestGrafana({
    alerts: [alert(), alert({ fingerprint: 'def' })],
  });
  // Assert
  expect(response.incidents.map((item) => item.runId)).toStrictEqual([
    'run-1',
    'run-2',
  ]);
  expect(calls.length).toBe(2);
});

it('concurrent retries enqueue only one execution', async () => {
  // Arrange
  const { service, calls } = setup();
  // Act
  await Promise.all([
    service.ingestGrafana({ alerts: [alert()] }),
    service.ingestGrafana({ alerts: [alert()] }),
  ]);
  // Assert
  expect(calls.length).toBe(1);
});

it('new startsAt creates another occurrence for the same fingerprint', async () => {
  // Arrange
  const { service, calls } = setup();
  await service.ingestGrafana({ alerts: [alert()] });
  await service.ingestGrafana({ alerts: [alert({ status: 'resolved' })] });
  // Act
  await service.ingestGrafana({
    alerts: [alert({ startsAt: '2026-09-16T12:00:00Z' })],
  });
  // Assert
  expect(calls.length).toBe(2);
  expect(calls[0].incidentId).not.toBe(calls[1].incidentId);
});

it('delayed firing cannot reopen a resolved occurrence', async () => {
  // Arrange
  const { service, calls } = setup();
  await service.ingestGrafana({ alerts: [alert({ status: 'resolved' })] });
  // Act
  const response = await service.ingestGrafana({ alerts: [alert()] });
  // Assert
  expect(response.incidents[0].status).toBe('resolved');
  expect(calls.length).toBe(0);
});

it('invalid batch has no partial writes', () => {
  // Arrange
  const { service, files } = setup();
  // Act / Assert
  expect(() =>
    service.ingestGrafana({
      alerts: [alert(), alert({ startsAt: 'invalid' })],
    }),
  ).toThrow(/startsAt/);
  expect(files).toStrictEqual({});
});

it('failed enqueue can be retried', async () => {
  // Arrange
  const { service, executions, calls } = setup();
  const enqueue = executions.enqueue;
  executions.enqueue = async () => {
    throw new Error('storage unavailable');
  };
  await expect(service.ingestGrafana({ alerts: [alert()] })).rejects.toThrow(
    /storage/,
  );
  executions.enqueue = enqueue;
  // Act
  await service.ingestGrafana({ alerts: [alert()] });
  // Assert
  expect(calls.length).toBe(1);
});

it('normalization preserves labels and rejects empty payload', () => {
  // Arrange
  const input = { alerts: [alert()] };
  // Act
  const [result] = normalizeGrafanaPayload(input);
  // Assert
  expect(result.labels.severity).toBe('critical');
  expect(() => normalizeGrafanaPayload({})).toThrow(/alerts/);
});

it('recurrence with open work skips diagnosis and announces it once', async () => {
  // Arrange
  const { service, calls, notified, files } = setup({
    suppression: {
      openUrls: ['https://github.com/o/r/pull/1'],
      openIssueUrls: [],
    },
  });
  await service.ingestGrafana({ alerts: [alert()] });
  const recurring = alert({ startsAt: new Date().toISOString() });
  // Act
  const response = await service.ingestGrafana({ alerts: [recurring] });
  await service.ingestGrafana({ alerts: [recurring] });
  // Assert
  const anchorId = calls[0].incidentId;
  expect(calls.length).toBe(1);
  expect(response.incidents[0].recurrenceOf).toBe(anchorId);
  expect(notified.length).toBe(1);
  expect(notified[0]).toMatchObject({
    count: 1,
    openUrls: ['https://github.com/o/r/pull/1'],
  });
  expect(files['incidents.json'][response.incidents[0].incidentId].runId).toBe(
    undefined,
  );
});

it('recurrence without open work is diagnosed again', async () => {
  // Arrange
  const { service, calls, notified } = setup();
  await service.ingestGrafana({
    alerts: [alert({ startsAt: new Date().toISOString() })],
  });
  // Act
  await service.ingestGrafana({
    alerts: [alert({ startsAt: new Date(Date.now() + 60_000).toISOString() })],
  });
  // Assert
  expect(calls.length).toBe(2);
  expect(notified.length).toBe(0);
});
