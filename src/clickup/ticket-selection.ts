import { includesClickUpArea } from '../config/area-values.js';
import type { ClickUpTask, TicketFields } from './clickup.types.js';
import {
  isClosed,
  matchesTicket,
  normalize,
  ticketFields,
  toIso,
  wasCreatedWithin,
  type TicketFilterConfig,
} from './clickup-task.js';

export interface EvaluatedTicket {
  task: ClickUpTask;
  matches: boolean;
  actual: TicketFields;
}

export interface FilterMismatchCounts {
  taskType: number;
  ticketType: number;
  area: number;
  closed: number;
  createdOutsideWindow: number;
}

export function evaluateTickets(
  tasks: readonly ClickUpTask[],
  config: TicketFilterConfig,
  manual: boolean,
): EvaluatedTicket[] {
  return tasks.map((task) =>
    manual
      ? { task, matches: true, actual: ticketFields(task, config) }
      : { task, ...matchesTicket(task, config) },
  );
}

export function filterMismatchCounts(
  evaluated: readonly EvaluatedTicket[],
  config: TicketFilterConfig,
): FilterMismatchCounts {
  return evaluated.reduce(
    (counts, { task, actual }) => {
      if (
        config.taskTypeId
          ? actual.taskTypeId !== String(config.taskTypeId)
          : normalize(actual.taskType) !== normalize(config.taskType)
      ) {
        counts.taskType += 1;
      }
      if (normalize(actual.ticketType) !== normalize(config.ticketTypeValue)) {
        counts.ticketType += 1;
      }
      if (!includesClickUpArea(config.areaValues, actual.area)) {
        counts.area += 1;
      }
      if (isClosed(task)) counts.closed += 1;
      if (!wasCreatedWithin(task, config.createdWithinMinutes)) {
        counts.createdOutsideWindow += 1;
      }
      return counts;
    },
    { taskType: 0, ticketType: 0, area: 0, closed: 0, createdOutsideWindow: 0 },
  );
}

export function processedTicketIds(
  processed: Readonly<Record<string, unknown>>,
): Set<string> {
  return new Set(Object.keys(processed).map((key) => key.split(':')[0]));
}

export function selectEligibleTickets(
  matched: readonly EvaluatedTicket[],
  processed: Readonly<Record<string, unknown>>,
  options: { force: boolean; maxTickets: number },
): EvaluatedTicket[] {
  const processedIds = processedTicketIds(processed);
  return [...matched]
    .sort(
      (left, right) =>
        Number(left.task.date_created || 0) -
        Number(right.task.date_created || 0),
    )
    .filter(({ task }) => options.force || !processedIds.has(String(task.id)))
    .slice(0, options.maxTickets);
}

export function ticketSummary({ task, actual }: EvaluatedTicket) {
  return {
    id: task.id,
    name: task.name,
    status:
      (typeof task.status === 'object' ? task.status?.status : undefined) ||
      task.status,
    created_at: toIso(task.date_created),
    updated_at: toIso(task.date_updated),
    filters: actual,
    url: task.url,
  };
}
