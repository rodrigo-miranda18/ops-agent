import { expect, it } from 'vitest';
import { buildImpactSummary, impactEvaluationsToCsv } from './impact-report.js';

function evaluation(score, band, confidence, classification = 'bug') {
  return {
    ticket: { custom_id: 'TICKET-1', name: 'Nome, com vírgula' },
    classification,
    impact: {
      ticket_id: `id-${score}`,
      rubric_version: '1.2.0',
      stage: 'final',
      confidence,
      attribution: 'PRODUCT_DEFECT',
      attribution_rationale: 'Defeito confirmado.',
      calculation: { score, band: { code: band } },
      dimensions: {
        reach: { level: 1 },
        functional_consequence: { level: 2 },
        journey_criticality: { level: 3 },
        duration: { level: 4 },
        incidence: { level: 2 },
      },
      recovery: {
        mode: 'supported_workaround',
        completeness: 'partial',
        customer_effort: 'high',
        residual_loss: true,
      },
      measurement: {
        affected_accounts: 1,
        eligible_accounts: 20,
        affected_users: 2,
        eligible_users: 40,
        affected_operations: 8,
        eligible_operations: 100,
        affected_count: null,
        eligible_count: null,
        unit: null,
        window_start: null,
        window_end: null,
        limitations: [],
      },
    },
  };
}

it('consolida distribuição, média e mediana', () => {
  const summary = buildImpactSummary([
    evaluation(10, 'LOW', 'low'),
    evaluation(50, 'HIGH', 'medium'),
    evaluation(90, 'CRITICAL', 'high'),
  ]);
  expect(summary.evaluated_tickets).toBe(3);
  expect(summary.skipped_tickets).toBe(0);
  expect(summary.score).toStrictEqual({
    minimum: 10,
    maximum: 90,
    average: 50,
    median: 50,
  });
  expect(summary.by_band).toStrictEqual({ LOW: 1, HIGH: 1, CRITICAL: 1 });
  expect(summary.by_attribution).toStrictEqual({ PRODUCT_DEFECT: 3 });
});

it('registra tickets não elegíveis sem produzir score', () => {
  const skipped = [
    {
      ticket_id: 'not-a-bug',
      classification: 'inconclusivo',
      reason: 'not eligible',
    },
  ];
  const summary = buildImpactSummary([], [], skipped);
  expect(summary.evaluated_tickets).toBe(0);
  expect(summary.skipped_tickets).toBe(1);
  expect(summary.skipped).toStrictEqual(skipped);
});

it('gera CSV escapando textos e preservando dimensões', () => {
  const csv = impactEvaluationsToCsv([evaluation(50, 'HIGH', 'medium')]);
  expect(csv).toMatch(/"Nome, com vírgula"/);
  expect(csv).toMatch(/id-50,TICKET-1/);
  expect(csv).toMatch(/Defeito confirmado/);
  expect(csv.trim().split('\n').length).toBe(2);
});
