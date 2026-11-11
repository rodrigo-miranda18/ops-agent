import { expect, it } from 'vitest';
import type { IncidentRecord } from './incidents.service.js';
import {
  countRecurrences,
  findRecurrenceAnchor,
  recurrenceMessage,
} from './incident-recurrence.js';

const now = new Date('2026-10-07T12:00:00Z');

function incident(changes: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    incidentId: 'grafana-new',
    fingerprint: 'fp',
    source: 'grafana',
    status: 'firing',
    title: '5xx',
    startedAt: '2026-10-07T11:59:00Z',
    receivedAt: '2026-10-07T11:59:30Z',
    updatedAt: '2026-10-07T11:59:30Z',
    labels: {},
    annotations: {},
    eventCount: 1,
    ...changes,
  };
}

it('anchors on the latest diagnosed occurrence of the same fingerprint', () => {
  // Arrange
  const current = incident();
  const incidents = [
    current,
    incident({
      incidentId: 'old',
      runId: 'r1',
      receivedAt: '2026-10-07T03:00:00Z',
    }),
    incident({
      incidentId: 'latest',
      runId: 'r2',
      receivedAt: '2026-10-07T10:00:00Z',
    }),
    incident({
      incidentId: 'suppressed',
      recurrenceOf: 'latest',
      receivedAt: '2026-10-07T11:00:00Z',
    }),
    incident({
      incidentId: 'other',
      fingerprint: 'x',
      runId: 'r3',
      receivedAt: '2026-10-07T11:30:00Z',
    }),
  ];
  // Act
  const anchor = findRecurrenceAnchor(incidents, current, now);
  // Assert
  expect(anchor?.incidentId).toBe('latest');
});

it('diagnoses again after the 6h window', () => {
  // Arrange
  const current = incident();
  const incidents = [
    current,
    incident({
      incidentId: 'stale',
      runId: 'r1',
      receivedAt: '2026-10-07T05:59:00Z',
    }),
  ];
  // Act
  const anchor = findRecurrenceAnchor(incidents, current, now);
  // Assert
  expect(anchor).toBeNull();
});

it('counts occurrences suppressed by the anchor', () => {
  // Arrange
  const incidents = [
    incident({ incidentId: 'a', recurrenceOf: 'anchor' }),
    incident({ incidentId: 'b', recurrenceOf: 'anchor' }),
    incident({ incidentId: 'c', recurrenceOf: 'other' }),
  ];
  // Act / Assert
  expect(countRecurrences(incidents, 'anchor')).toBe(2);
});

it('builds a one-line Chat message with open links and the rediagnosis time', () => {
  // Arrange
  const anchor = incident({
    incidentId: 'anchor',
    receivedAt: '2026-10-07T03:02:37Z',
  });
  // Act
  const message = recurrenceMessage({
    incident: incident({ startedAt: '2026-10-07T03:32:00Z' }),
    anchor,
    count: 2,
    openUrls: ['https://github.com/o/r/pull/1'],
  });
  // Assert
  expect(message).not.toContain('\n');
  expect(message).toContain('07/10, 00:32');
  expect(message).toContain('recorrência 2');
  expect(message).toContain('https://github.com/o/r/pull/1');
  expect(message).toContain('07/10, 06:02');
});
