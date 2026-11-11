import {
  type ConfidenceLevel,
  isConfidenceLevel,
} from '../diagnosis/engineering-action.js';

export const CUSTOMER_IMPACT_RUBRIC_VERSION = '1.2.0';

export const CUSTOMER_IMPACT_DIMENSIONS = Object.freeze({
  reach: 25,
  functional_consequence: 30,
  journey_criticality: 25,
  duration: 10,
  incidence: 10,
});

export type CustomerImpactDimensionName =
  keyof typeof CUSTOMER_IMPACT_DIMENSIONS;

export const CUSTOMER_IMPACT_SPECIAL_CONDITIONS = Object.freeze([
  'SECURITY_OR_PRIVACY_EXPOSURE',
  'IRREVERSIBLE_DATA_LOSS',
  'IMPROPER_FINANCIAL_ACTION',
  'MASS_EXTERNAL_COMMUNICATION',
] as const);

export type CustomerImpactSpecialCondition =
  (typeof CUSTOMER_IMPACT_SPECIAL_CONDITIONS)[number];

const ASSESSMENT_STAGES = new Set<unknown>(['initial', 'observed', 'final']);
const SPECIAL_CONDITIONS = new Set<unknown>(CUSTOMER_IMPACT_SPECIAL_CONDITIONS);
const RECOVERY_MODES = new Set<unknown>([
  'automatic',
  'simple_retry',
  'supported_workaround',
  'assisted_manual',
  'none',
]);
const RECOVERY_COMPLETENESS = new Set<unknown>([
  'complete',
  'partial',
  'impossible',
]);
const CUSTOMER_EFFORT_LEVELS = new Set<unknown>(['none', 'low', 'high']);
const ATTRIBUTIONS = new Set<unknown>([
  'PRODUCT_DEFECT',
  'PRODUCT_DESIGN_GAP',
  'EXTERNAL_DEPENDENCY',
  'CUSTOMER_CONFIGURATION_OR_USE',
  'MIXED',
  'UNCONFIRMED',
]);

type UnknownRecord = Record<string, unknown>;

export interface CustomerImpactDimension {
  level: number;
  rationale: string;
  evidence: string[];
}

export interface CustomerImpactRecovery {
  mode: string | null;
  completeness: string | null;
  customer_effort: string | null;
  residual_loss: boolean | null;
}

export interface CustomerImpactMeasurement {
  affected_count: number | null;
  eligible_count: number | null;
  affected_accounts: number | null;
  eligible_accounts: number | null;
  affected_users: number | null;
  eligible_users: number | null;
  affected_operations: number | null;
  eligible_operations: number | null;
  unit: string | null;
  window_start: string | null;
  window_end: string | null;
  sources: string[];
  limitations: string[];
}

export interface CustomerImpactBand {
  code: 'NONE' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  label: string;
}

export interface CustomerImpact {
  rubric_version: string;
  stage: string;
  confidence: ConfidenceLevel;
  attribution: string;
  attribution_rationale: string;
  dimensions: Record<CustomerImpactDimensionName, CustomerImpactDimension>;
  recovery: CustomerImpactRecovery;
  measurement: CustomerImpactMeasurement;
  special_conditions: CustomerImpactSpecialCondition[];
  calculation: {
    raw_score: number;
    score: number;
    band: CustomerImpactBand;
    applied_limiters: string[];
    requires_human_review: boolean;
  };
}

export function calculateCustomerImpact(input: unknown): CustomerImpact {
  if (!isObject(input)) {
    throw new Error('Customer impact assessment must be an object');
  }
  if (!ASSESSMENT_STAGES.has(input.stage)) {
    throw new Error('Invalid customer impact stage');
  }
  if (!isConfidenceLevel(input.confidence)) {
    throw new Error('Invalid customer impact confidence');
  }
  if (!ATTRIBUTIONS.has(input.attribution)) {
    throw new Error('Invalid customer impact attribution');
  }
  if (
    typeof input.attribution_rationale !== 'string' ||
    !input.attribution_rationale.trim()
  ) {
    throw new Error('Customer impact attribution must have a rationale');
  }
  if (!isObject(input.dimensions)) {
    throw new Error('Customer impact dimensions must be an object');
  }

  const dimensions = {} as Record<
    CustomerImpactDimensionName,
    CustomerImpactDimension
  >;
  let rawScore = 0;
  for (const [name, weight] of Object.entries(CUSTOMER_IMPACT_DIMENSIONS) as [
    CustomerImpactDimensionName,
    number,
  ][]) {
    const dimension = input.dimensions[name];
    if (!isObject(dimension)) {
      throw new Error(`Missing customer impact dimension: ${name}`);
    }
    const level = dimension.level;
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < 0 ||
      level > 4
    ) {
      throw new Error(
        `Customer impact dimension ${name} must have an integer level from 0 to 4`,
      );
    }
    if (
      typeof dimension.rationale !== 'string' ||
      !dimension.rationale.trim()
    ) {
      throw new Error(
        `Customer impact dimension ${name} must have a rationale`,
      );
    }
    if (!isStringArray(dimension.evidence)) {
      throw new Error(
        `Customer impact dimension ${name} evidence must be an array of strings`,
      );
    }
    dimensions[name] = {
      level,
      rationale: dimension.rationale.trim(),
      evidence: dimension.evidence.map((item) => item.trim()).filter(Boolean),
    };
    rawScore += (weight * level) / 4;
  }

  const specialConditions = normalizeSpecialConditions(
    input.special_conditions,
  );
  const consequence = dimensions.functional_consequence.level;
  if (specialConditions.length && consequence < 3) {
    throw new Error(
      'Confirmed special conditions require functional_consequence level 3 or 4',
    );
  }

  let score = Math.round(rawScore);
  const appliedLimiters: string[] = [];
  if (consequence === 0) {
    score = 0;
    appliedLimiters.push('NO_CONFIRMED_FUNCTIONAL_IMPACT');
  } else if (consequence === 1 && score > 39) {
    score = 39;
    appliedLimiters.push('FUNCTIONAL_CONSEQUENCE_1_CAP');
  } else if (consequence === 2 && score > 59) {
    score = 59;
    appliedLimiters.push('FUNCTIONAL_CONSEQUENCE_2_CAP');
  } else if (consequence === 4 && score < 50) {
    score = 50;
    appliedLimiters.push('FUNCTIONAL_CONSEQUENCE_4_FLOOR');
  }
  if (specialConditions.length && score < 75) {
    score = 75;
    appliedLimiters.push('SPECIAL_CONDITION_FLOOR');
  }

  return {
    rubric_version: CUSTOMER_IMPACT_RUBRIC_VERSION,
    stage: input.stage as string,
    confidence: input.confidence,
    attribution: input.attribution as string,
    attribution_rationale: input.attribution_rationale.trim(),
    dimensions,
    recovery: normalizeRecovery(input.recovery),
    measurement: normalizeMeasurement(input.measurement),
    special_conditions: specialConditions,
    calculation: {
      raw_score: roundTo(rawScore, 2),
      score,
      band: bandFor(score),
      applied_limiters: appliedLimiters,
      requires_human_review: specialConditions.length > 0,
    },
  };
}

function normalizeRecovery(value: unknown): CustomerImpactRecovery {
  if (value === undefined || value === null) return defaultRecovery();
  if (!isObject(value)) {
    throw new Error('Customer impact recovery must be an object');
  }
  return {
    mode: nullableEnum(value.mode, RECOVERY_MODES, 'recovery mode'),
    completeness: nullableEnum(
      value.completeness,
      RECOVERY_COMPLETENESS,
      'recovery completeness',
    ),
    customer_effort: nullableEnum(
      value.customer_effort,
      CUSTOMER_EFFORT_LEVELS,
      'recovery customer_effort',
    ),
    residual_loss: nullableBoolean(
      value.residual_loss,
      'recovery residual_loss',
    ),
  };
}

function defaultRecovery(): CustomerImpactRecovery {
  return {
    mode: null,
    completeness: null,
    customer_effort: null,
    residual_loss: null,
  };
}

function normalizeSpecialConditions(
  value: unknown,
): CustomerImpactSpecialCondition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Customer impact special_conditions must be an array');
  }
  const result: CustomerImpactSpecialCondition[] = [];
  for (const condition of value as unknown[]) {
    if (!SPECIAL_CONDITIONS.has(condition)) {
      throw new Error(
        `Invalid customer impact special condition: ${String(condition)}`,
      );
    }
    const known = condition as CustomerImpactSpecialCondition;
    if (!result.includes(known)) result.push(known);
  }
  return result;
}

function normalizeMeasurement(value: unknown): CustomerImpactMeasurement {
  if (value === undefined || value === null) return defaultMeasurement();
  if (!isObject(value)) {
    throw new Error('Customer impact measurement must be an object');
  }
  const affectedCount = nullableNonNegativeNumber(
    value.affected_count,
    'affected_count',
  );
  const eligibleCount = nullableNonNegativeNumber(
    value.eligible_count,
    'eligible_count',
  );
  if (
    affectedCount !== null &&
    eligibleCount !== null &&
    affectedCount > eligibleCount
  ) {
    throw new Error(
      'Customer impact affected_count cannot exceed eligible_count',
    );
  }
  if (value.sources !== undefined && !isStringArray(value.sources)) {
    throw new Error(
      'Customer impact measurement sources must be an array of strings',
    );
  }
  if (value.limitations !== undefined && !isStringArray(value.limitations)) {
    throw new Error(
      'Customer impact measurement limitations must be an array of strings',
    );
  }
  const sources = (value.sources || []) as string[];
  const limitations = (value.limitations || []) as string[];
  const measurement: CustomerImpactMeasurement = {
    affected_count: affectedCount,
    eligible_count: eligibleCount,
    affected_accounts: nullableNonNegativeNumber(
      value.affected_accounts,
      'affected_accounts',
    ),
    eligible_accounts: nullableNonNegativeNumber(
      value.eligible_accounts,
      'eligible_accounts',
    ),
    affected_users: nullableNonNegativeNumber(
      value.affected_users,
      'affected_users',
    ),
    eligible_users: nullableNonNegativeNumber(
      value.eligible_users,
      'eligible_users',
    ),
    affected_operations: nullableNonNegativeNumber(
      value.affected_operations,
      'affected_operations',
    ),
    eligible_operations: nullableNonNegativeNumber(
      value.eligible_operations,
      'eligible_operations',
    ),
    unit: nullableString(value.unit),
    window_start: nullableString(value.window_start),
    window_end: nullableString(value.window_end),
    sources: sources.map((item) => item.trim()).filter(Boolean),
    limitations: limitations.map((item) => item.trim()).filter(Boolean),
  };
  validateMeasurementPair(measurement, 'accounts');
  validateMeasurementPair(measurement, 'users');
  validateMeasurementPair(measurement, 'operations');
  return measurement;
}

function validateMeasurementPair(
  measurement: CustomerImpactMeasurement,
  unit: 'accounts' | 'users' | 'operations',
): void {
  const affected = measurement[`affected_${unit}`];
  const eligible = measurement[`eligible_${unit}`];
  if (affected !== null && eligible !== null && affected > eligible) {
    throw new Error(
      `Customer impact affected_${unit} cannot exceed eligible_${unit}`,
    );
  }
}

function defaultMeasurement(): CustomerImpactMeasurement {
  return {
    affected_count: null,
    eligible_count: null,
    affected_accounts: null,
    eligible_accounts: null,
    affected_users: null,
    eligible_users: null,
    affected_operations: null,
    eligible_operations: null,
    unit: null,
    window_start: null,
    window_end: null,
    sources: [],
    limitations: [],
  };
}

function nullableNonNegativeNumber(
  value: unknown,
  name: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Customer impact measurement ${name} must be a non-negative number or null`,
    );
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(
      'Customer impact optional text values must be strings or null',
    );
  }
  return value.trim() || null;
}

function nullableEnum(
  value: unknown,
  allowed: ReadonlySet<unknown>,
  name: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!allowed.has(value)) throw new Error(`Invalid customer impact ${name}`);
  return value as string;
}

function nullableBoolean(value: unknown, name: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new Error(`Customer impact ${name} must be a boolean or null`);
  }
  return value;
}

function bandFor(score: number): CustomerImpactBand {
  if (score === 0) return { code: 'NONE', label: 'Sem impacto confirmado' };
  if (score <= 24) return { code: 'LOW', label: 'Baixo' };
  if (score <= 49) return { code: 'MODERATE', label: 'Moderado' };
  if (score <= 74) return { code: 'HIGH', label: 'Alto' };
  return { code: 'CRITICAL', label: 'Crítico' };
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    !(value as unknown[]).some((item) => typeof item !== 'string')
  );
}

function isObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
