import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { StateService } from '../state/state.service.js';
import { DiagnosisExecutionService } from '../diagnosis/diagnosis-execution.service.js';
import {
  countRecurrences,
  findRecurrenceAnchor,
} from './incident-recurrence.js';
import { IncidentRecurrenceService } from './incident-recurrence.service.js';

export interface IncidentRecord {
  incidentId: string;
  fingerprint: string;
  source: 'grafana';
  status: 'firing' | 'resolved';
  title: string;
  startedAt: string;
  receivedAt: string;
  updatedAt: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  severity?: string;
  generatorURL?: string;
  eventCount: number;
  runId?: string;
  recurrenceOf?: string;
}

export function normalizeGrafanaPayload(payload: unknown): IncidentRecord[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new BadRequestException('Expected Grafana payload');
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.alerts) || !body.alerts.length)
    throw new BadRequestException('alerts must be a non-empty array');
  return body.alerts.map((alert) => {
    if (!alert || !['firing', 'resolved'].includes(alert.status))
      throw new BadRequestException('Invalid alert status');
    if (typeof alert.fingerprint !== 'string' || !alert.fingerprint.trim())
      throw new BadRequestException('fingerprint is required');
    if (
      typeof alert.startsAt !== 'string' ||
      !Number.isFinite(Date.parse(alert.startsAt))
    )
      throw new BadRequestException('Valid startsAt is required');
    const labels = stringMap(alert.labels);
    const annotations = stringMap(alert.annotations);
    const startedAt = new Date(alert.startsAt).toISOString();
    const now = new Date().toISOString();
    return {
      incidentId:
        'grafana-' +
        createHash('sha256')
          .update(JSON.stringify([alert.fingerprint, startedAt]))
          .digest('hex'),
      source: 'grafana',
      fingerprint: alert.fingerprint,
      status: alert.status,
      title: annotations.summary || labels.alertname || 'Grafana incident',
      startedAt,
      receivedAt: now,
      updatedAt: now,
      labels,
      annotations,
      severity: labels.severity,
      generatorURL:
        typeof alert.generatorURL === 'string' ? alert.generatorURL : undefined,
      eventCount: 0,
    };
  });
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Expected labels/annotations object');
  if (Object.values(value).some((item) => typeof item !== 'string'))
    throw new BadRequestException('Labels/annotations must contain strings');
  return value as Record<string, string>;
}

@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);
  private queue = Promise.resolve<unknown>(undefined);
  constructor(
    private readonly state: StateService,
    private readonly executions: DiagnosisExecutionService,
    private readonly recurrence: IncidentRecurrenceService,
  ) {}

  ingestGrafana(payload: unknown) {
    const alerts = normalizeGrafanaPayload(payload);
    const operation = this.queue.then(async () => {
      const results = [];
      for (const alert of alerts) {
        const records = await this.state.update<Record<string, IncidentRecord>>(
          'incidents.json',
          (items) => {
            const previous = items[alert.incidentId];
            items[alert.incidentId] = {
              ...alert,
              runId: previous?.runId,
              recurrenceOf: previous?.recurrenceOf,
              receivedAt: previous?.receivedAt || alert.receivedAt,
              status:
                previous?.status === 'resolved' ? 'resolved' : alert.status,
              eventCount: (previous?.eventCount || 0) + 1,
            };
          },
        );
        const incident = records[alert.incidentId];
        const pending =
          incident.status === 'firing' &&
          !incident.runId &&
          !incident.recurrenceOf;
        if (pending)
          await this.suppressRecurrence(incident, Object.values(records));
        if (pending && !incident.recurrenceOf) {
          const run = await this.executions.enqueue({
            incidentId: incident.incidentId,
            source: 'grafana',
            remediation: 'auto',
            notify: true,
          });
          await this.state.update<Record<string, IncidentRecord>>(
            'incidents.json',
            (items) => {
              items[incident.incidentId].runId = run.runId;
            },
          );
          incident.runId = run.runId;
        }
        results.push({
          incidentId: incident.incidentId,
          runId: incident.runId,
          recurrenceOf: incident.recurrenceOf,
          status: incident.status,
          duplicate: incident.eventCount > 1,
        });
      }
      return { accepted: true, incidents: results };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async suppressRecurrence(
    incident: IncidentRecord,
    incidents: IncidentRecord[],
  ) {
    const anchor = findRecurrenceAnchor(incidents, incident, new Date());
    if (!anchor) return;
    const suppression = await this.recurrence.suppressionFor(anchor);
    if (!suppression) return;
    const records = await this.state.update<Record<string, IncidentRecord>>(
      'incidents.json',
      (items) => {
        items[incident.incidentId].recurrenceOf = anchor.incidentId;
      },
    );
    incident.recurrenceOf = anchor.incidentId;
    const count = countRecurrences(Object.values(records), anchor.incidentId);
    this.logger.log(
      `Incident ${incident.incidentId} is recurrence ${count} of ${anchor.incidentId}; diagnosis skipped`,
    );
    void this.recurrence
      .announce({ incident, anchor, count, ...suppression })
      .catch((error: Error) =>
        this.logger.error(
          `Recurrence notification failed for ${incident.incidentId}: ${error.message}`,
        ),
      );
  }
}
