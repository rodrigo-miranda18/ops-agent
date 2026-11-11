import { expect, it } from 'vitest';
import {
  calculateCustomerImpact,
  CUSTOMER_IMPACT_RUBRIC_VERSION,
} from './customer-impact.js';

function assessment(levels, overrides = {}) {
  const dimension = (level) => ({
    level,
    rationale: `Nível ${level} confirmado`,
    evidence: ['fonte verificável'],
  });
  return {
    stage: 'observed',
    confidence: 'high',
    attribution: 'PRODUCT_DEFECT',
    attribution_rationale: 'Comportamento incorreto confirmado no produto.',
    dimensions: {
      reach: dimension(levels.reach),
      functional_consequence: dimension(levels.functional_consequence),
      journey_criticality: dimension(levels.journey_criticality),
      duration: dimension(levels.duration),
      incidence: dimension(levels.incidence),
    },
    measurement: {
      affected_count: 8,
      eligible_count: 100,
      affected_accounts: 2,
      eligible_accounts: 40,
      affected_users: 4,
      eligible_users: 80,
      affected_operations: 8,
      eligible_operations: 100,
      unit: 'operações',
      window_start: '2026-08-01T00:00:00Z',
      window_end: '2026-08-04T00:00:00Z',
      sources: ['banco', 'logs'],
      limitations: [],
    },
    special_conditions: [],
    ...overrides,
  };
}

it('calcula o exemplo crítico documentado de forma determinística', () => {
  const result = calculateCustomerImpact(
    assessment({
      reach: 3,
      functional_consequence: 3,
      journey_criticality: 4,
      duration: 3,
      incidence: 3,
    }),
  );

  expect(result.rubric_version).toBe(CUSTOMER_IMPACT_RUBRIC_VERSION);
  expect(result.calculation.raw_score).toBe(81.25);
  expect(result.calculation.score).toBe(81);
  expect(result.calculation.band).toStrictEqual({
    code: 'CRITICAL',
    label: 'Crítico',
  });
  expect(result.calculation.applied_limiters).toStrictEqual([]);
});

it('força score zero quando não há impacto funcional confirmado', () => {
  const result = calculateCustomerImpact(
    assessment({
      reach: 4,
      functional_consequence: 0,
      journey_criticality: 4,
      duration: 4,
      incidence: 4,
    }),
  );

  expect(result.calculation.raw_score).toBe(70);
  expect(result.calculation.score).toBe(0);
  expect(result.calculation.band.code).toBe('NONE');
  expect(result.calculation.applied_limiters).toStrictEqual([
    'NO_CONFIRMED_FUNCTIONAL_IMPACT',
  ]);
});

it('limita impacto cosmético disseminado a 39', () => {
  const result = calculateCustomerImpact(
    assessment({
      reach: 4,
      functional_consequence: 1,
      journey_criticality: 4,
      duration: 4,
      incidence: 4,
    }),
  );

  expect(result.calculation.score).toBe(39);
  expect(result.calculation.band.code).toBe('MODERATE');
  expect(result.calculation.applied_limiters).toStrictEqual([
    'FUNCTIONAL_CONSEQUENCE_1_CAP',
  ]);
});

it('limita degradação funcional a 59', () => {
  const result = calculateCustomerImpact(
    assessment({
      reach: 4,
      functional_consequence: 2,
      journey_criticality: 4,
      duration: 4,
      incidence: 4,
    }),
  );

  expect(result.calculation.score).toBe(59);
  expect(result.calculation.applied_limiters).toStrictEqual([
    'FUNCTIONAL_CONSEQUENCE_2_CAP',
  ]);
});

it('aplica piso 50 para consequência funcional máxima confirmada', () => {
  const result = calculateCustomerImpact(
    assessment({
      reach: 0,
      functional_consequence: 4,
      journey_criticality: 0,
      duration: 0,
      incidence: 0,
    }),
  );

  expect(result.calculation.raw_score).toBe(30);
  expect(result.calculation.score).toBe(50);
  expect(result.calculation.applied_limiters).toStrictEqual([
    'FUNCTIONAL_CONSEQUENCE_4_FLOOR',
  ]);
});

it('condição especial exige revisão humana e piso 75', () => {
  const result = calculateCustomerImpact(
    assessment(
      {
        reach: 1,
        functional_consequence: 3,
        journey_criticality: 1,
        duration: 1,
        incidence: 1,
      },
      { special_conditions: ['SECURITY_OR_PRIVACY_EXPOSURE'] },
    ),
  );

  expect(result.calculation.score).toBe(75);
  expect(result.calculation.requires_human_review).toBe(true);
  expect(result.calculation.band.code).toBe('CRITICAL');
  expect(result.calculation.applied_limiters).toStrictEqual([
    'SPECIAL_CONDITION_FLOOR',
  ]);
});

it('rejeita dimensões fora da rubrica', () => {
  expect(() =>
    calculateCustomerImpact(
      assessment({
        reach: 5,
        functional_consequence: 3,
        journey_criticality: 2,
        duration: 2,
        incidence: 2,
      }),
    ),
  ).toThrow(/integer level from 0 to 4/);
});

it('rejeita numerador de alcance maior que o denominador', () => {
  const input = assessment({
    reach: 2,
    functional_consequence: 2,
    journey_criticality: 2,
    duration: 2,
    incidence: 2,
  });
  input.measurement.affected_count = 101;

  expect(() => calculateCustomerImpact(input)).toThrow(
    /cannot exceed eligible_count/,
  );
});

it('rejeita contagem afetada maior que a elegível em cada unidade tipada', () => {
  for (const unit of ['accounts', 'users', 'operations']) {
    const input = assessment({
      reach: 2,
      functional_consequence: 2,
      journey_criticality: 2,
      duration: 2,
      incidence: 2,
    });
    input.measurement[`affected_${unit}`] =
      input.measurement[`eligible_${unit}`] + 1;
    expect(() => calculateCustomerImpact(input)).toThrow(
      new RegExp(`affected_${unit} cannot exceed eligible_${unit}`),
    );
  }
});

it('exige atribuição causal e justificativa sem alterar a nota de impacto', () => {
  const levels = {
    reach: 2,
    functional_consequence: 3,
    journey_criticality: 3,
    duration: 2,
    incidence: 2,
  };
  const defect = calculateCustomerImpact(assessment(levels));
  const external = calculateCustomerImpact(
    assessment(levels, {
      attribution: 'EXTERNAL_DEPENDENCY',
      attribution_rationale: 'Falha confirmada no provedor externo.',
    }),
  );

  expect(defect.calculation.score).toBe(external.calculation.score);
  expect(external.attribution).toBe('EXTERNAL_DEPENDENCY');
  expect(() =>
    calculateCustomerImpact(assessment(levels, { attribution: 'UNKNOWN' })),
  ).toThrow(/Invalid customer impact attribution/);
});

it('rejeita condição especial incompatível com consequência baixa', () => {
  expect(() =>
    calculateCustomerImpact(
      assessment(
        {
          reach: 1,
          functional_consequence: 2,
          journey_criticality: 1,
          duration: 1,
          incidence: 1,
        },
        { special_conditions: ['IRREVERSIBLE_DATA_LOSS'] },
      ),
    ),
  ).toThrow(/require functional_consequence level 3 or 4/);
});
