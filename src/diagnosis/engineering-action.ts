export const ENGINEERING_DECISIONS = [
  'CORRECTION_REQUIRED',
  'IMPROVEMENT_RECOMMENDED',
  'NO_CODE_ACTION',
  'INSUFFICIENT_EVIDENCE',
  'ALREADY_FIXED',
] as const;
export type EngineeringDecision = (typeof ENGINEERING_DECISIONS)[number];

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export function isEngineeringDecision(
  value: unknown,
): value is EngineeringDecision {
  return (ENGINEERING_DECISIONS as readonly unknown[]).includes(value);
}

export function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return (CONFIDENCE_LEVELS as readonly unknown[]).includes(value);
}
