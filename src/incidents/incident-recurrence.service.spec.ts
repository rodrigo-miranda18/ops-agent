import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { IncidentRecurrenceService } from './incident-recurrence.service.js';

const issueUrl = 'https://github.com/o/r/issues/1';
const closedIssueUrl = 'https://github.com/o/r/issues/2';
const prUrl = 'https://github.com/o/r/pull/3';

const anchor = {
  incidentId: 'grafana-anchor',
  fingerprint: 'fp',
  source: 'grafana' as const,
  status: 'firing' as const,
  title: '5xx',
  startedAt: '2026-10-07T03:02:00.000Z',
  receivedAt: '2026-10-07T03:02:37.000Z',
  updatedAt: '2026-10-07T03:02:37.000Z',
  labels: {},
  annotations: {},
  eventCount: 1,
  runId: 'run-1',
};
const incident = {
  ...anchor,
  incidentId: 'grafana-next',
  startedAt: '2026-10-07T03:17:00.000Z',
  severity: 'critical',
  runId: undefined,
};

async function setup({ active = false } = {}) {
  const resultsDir = await mkdtemp(path.join(tmpdir(), 'recurrence-'));
  const ticketDir = path.join(resultsDir, anchor.incidentId);
  await mkdir(ticketDir);
  await writeFile(
    path.join(ticketDir, 'github-issues.json'),
    JSON.stringify([{ url: issueUrl }, { url: closedIssueUrl }]),
  );
  await writeFile(
    path.join(ticketDir, 'remediation.json'),
    JSON.stringify({ pull_requests: [{ url: prUrl }] }),
  );
  await writeFile(
    path.join(ticketDir, 'ticket.json'),
    JSON.stringify({ vectors: ['Engagement'] }),
  );
  const comments: [string, string][] = [];
  const messages: unknown[][] = [];
  const state = {
    async read() {
      return {
        binding: {
          space: 'spaces/A',
          taskId: anchor.incidentId,
          threadName: 'spaces/A/threads/T',
        },
      };
    },
  };
  const executions = {
    async findActiveByTicket() {
      return active ? { runId: 'run-1' } : null;
    },
  };
  const github = {
    async viewIssue(url: string) {
      return { url, state: url === closedIssueUrl ? 'CLOSED' : 'OPEN' };
    },
    async viewPullRequest(url: string) {
      return { url, state: 'OPEN' };
    },
    async commentIssue(url: string, body: string) {
      comments.push([url, body]);
    },
  };
  const messenger = {
    async sendMessage(...args: unknown[]) {
      messages.push(args);
    },
  };
  const service = new IncidentRecurrenceService(
    state as never,
    executions as never,
    github as never,
    messenger as never,
    { resultsDir } as never,
  );
  return { service, comments, messages };
}

it('separates open issues from open pull requests', async () => {
  // Arrange
  const { service } = await setup();
  // Act
  const suppression = await service.suppressionFor(anchor);
  // Assert
  expect(suppression).toStrictEqual({
    openUrls: [issueUrl, prUrl],
    openIssueUrls: [issueUrl],
  });
});

it('suppresses while the anchor run is still active', async () => {
  // Arrange
  const { service } = await setup({ active: true });
  // Act
  const suppression = await service.suppressionFor(anchor);
  // Assert
  expect(suppression).toStrictEqual({ openUrls: [], openIssueUrls: [] });
});

it('comments the recurrence on open issues and posts in the Chat thread', async () => {
  // Arrange
  const { service, comments, messages } = await setup();
  // Act
  await service.announce({
    incident,
    anchor,
    count: 1,
    openUrls: [issueUrl, prUrl],
    openIssueUrls: [issueUrl],
  });
  // Assert
  expect(comments).toHaveLength(1);
  expect(comments[0][0]).toBe(issueUrl);
  expect(comments[0][1]).toContain('O alerta voltou a disparar');
  expect(comments[0][1]).toContain('- Incidente: grafana-next');
  expect(comments[0][1]).toContain('- Severidade: critical');
  expect(comments[0][1]).toContain('- Vetor: Engagement');
  expect(messages).toHaveLength(1);
  expect(messages[0][0]).toBe('spaces/A');
  expect(messages[0][2]).toStrictEqual({ threadName: 'spaces/A/threads/T' });
});
