import { describe, expect, it } from 'vitest';
import type { TicketFilterConfig } from './clickup-task.js';
import type { ClickUpTask } from './clickup.types.js';
import {
  evaluateTickets,
  filterMismatchCounts,
  selectEligibleTickets,
  processedTicketIds,
  ticketSummary,
} from './ticket-selection.js';

const filter: TicketFilterConfig = {
  taskType: 'Ticket',
  taskTypeId: '',
  ticketTypeFieldId: '',
  ticketTypeField: 'Tipo',
  ticketTypeValue: 'Bug',
  areaFieldId: '',
  areaField: 'Área',
  areaValues: ['Engajamento'],
  vectorsFieldId: '',
  vectorsField: 'Vetores',
  tags: [],
  createdWithinMinutes: 60,
};

function task(id: string, overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id,
    name: `Ticket ${id}`,
    status: { status: 'open', type: 'open' },
    date_created: String(Date.now() - 10 * 60_000),
    date_updated: '1790000000000',
    task_type: { name: 'Ticket' },
    custom_fields: [
      { name: 'Tipo', value: 'Bug' },
      { name: 'Área', value: 'Engajamento' },
    ],
    ...overrides,
  };
}

describe('evaluateTickets', () => {
  it('applies the automatic filters', () => {
    const [closed] = evaluateTickets(
      [task('1', { status: { status: 'closed', type: 'closed' } })],
      filter,
      false,
    );
    expect(closed.matches).toBe(false);
  });

  it('accepts any manual ticket and still reports its fields', () => {
    const [manual] = evaluateTickets(
      [task('1', { status: { status: 'closed', type: 'closed' } })],
      filter,
      true,
    );
    expect(manual).toMatchObject({
      matches: true,
      actual: { taskType: 'Ticket', area: 'Engajamento' },
    });
  });
});

describe('filterMismatchCounts', () => {
  it('counts each failed filter', () => {
    const evaluated = evaluateTickets(
      [
        task('1', { status: { status: 'closed', type: 'closed' } }),
        task('2', { date_created: '0', custom_fields: [] }),
      ],
      filter,
      false,
    );
    expect(filterMismatchCounts(evaluated, filter)).toEqual({
      taskType: 0,
      ticketType: 1,
      area: 1,
      closed: 1,
      createdOutsideWindow: 1,
    });
  });
});

describe('selectEligibleTickets', () => {
  const evaluated = evaluateTickets(
    [
      task('late', { date_created: '3000' }),
      task('early', { date_created: '1000' }),
      task('middle', { date_created: '2000' }),
    ],
    filter,
    true,
  );

  it('orders by creation, skips processed tickets and caps the batch', () => {
    const processed = { 'early:2026-09-21T14:13:20.000Z': {} };
    const eligible = selectEligibleTickets(evaluated, processed, {
      force: false,
      maxTickets: 1,
    });
    expect(eligible.map(({ task }) => task.id)).toEqual(['middle']);
  });

  it('skips a processed ticket even after it was updated', () => {
    const processed = {
      'early:2020-01-01T00:00:00.000Z': {},
      'middle:': {},
    };
    const eligible = selectEligibleTickets(evaluated, processed, {
      force: false,
      maxTickets: 5,
    });
    expect(eligible.map(({ task }) => task.id)).toEqual(['late']);
  });

  it('reprocesses tickets when forced', () => {
    const processed = { 'early:2026-09-21T14:13:20.000Z': {} };
    const eligible = selectEligibleTickets(evaluated, processed, {
      force: true,
      maxTickets: 5,
    });
    expect(eligible.map(({ task }) => task.id)).toEqual([
      'early',
      'middle',
      'late',
    ]);
  });
});

describe('processedTicketIds', () => {
  it('extracts ticket ids from processed version keys', () => {
    expect(
      processedTicketIds({
        '1:2026-09-21T14:13:20.000Z': {},
        '2:': {},
        '1:x': {},
      }),
    ).toStrictEqual(new Set(['1', '2']));
  });
});

describe('ticketSummary', () => {
  it('flattens the ClickUp status', () => {
    const [evaluated] = evaluateTickets([task('1')], filter, true);
    expect(ticketSummary(evaluated)).toMatchObject({ id: '1', status: 'open' });
  });
});
