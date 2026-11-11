import type { IncidentRecord } from './incidents.service.js';

export const INCIDENT_RECURRENCE_WINDOW_MS = 6 * 60 * 60 * 1000;

export function findRecurrenceAnchor(
  incidents: IncidentRecord[],
  incident: IncidentRecord,
  now: Date,
): IncidentRecord | null {
  const since = now.getTime() - INCIDENT_RECURRENCE_WINDOW_MS;
  const candidates = incidents.filter(
    (candidate) =>
      candidate.incidentId !== incident.incidentId &&
      candidate.fingerprint === incident.fingerprint &&
      candidate.runId &&
      Date.parse(candidate.receivedAt) >= since,
  );
  return (
    candidates.sort(
      (left, right) =>
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
    )[0] || null
  );
}

export function countRecurrences(
  incidents: IncidentRecord[],
  anchorId: string,
): number {
  return incidents.filter((incident) => incident.recurrenceOf === anchorId)
    .length;
}

export function isOpenGitHubState(state: string): boolean {
  return state.toUpperCase() === 'OPEN';
}

export function recurrenceMessage(input: {
  incident: IncidentRecord;
  anchor: IncidentRecord;
  count: number;
  openUrls: string[];
}): string {
  const rediagnoseAt = new Date(
    Date.parse(input.anchor.receivedAt) + INCIDENT_RECURRENCE_WINDOW_MS,
  );
  const reason = input.openUrls.length
    ? `há issue/PR aberto (${input.openUrls.join(', ')})`
    : 'o diagnóstico anterior ainda está em andamento';
  return (
    `🔁 O alerta disparou de novo em ${formatTime(input.incident.startedAt)} ` +
    `(recorrência ${input.count}). Não diagnostiquei de novo porque ${reason}; ` +
    `se continuar após ${formatTime(rediagnoseAt.toISOString())}, faço um diagnóstico novo.`
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
