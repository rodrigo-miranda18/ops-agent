interface ImpactReportDimension {
  level: number;
}

export interface ImpactReportImpact {
  ticket_id?: unknown;
  rubric_version?: string;
  stage?: string;
  confidence?: string;
  attribution?: string;
  attribution_rationale?: string;
  calculation: { score: number; band: { code: string } };
  dimensions: Record<
    | 'reach'
    | 'functional_consequence'
    | 'journey_criticality'
    | 'duration'
    | 'incidence',
    ImpactReportDimension
  >;
  recovery: {
    mode: string | null;
    completeness: string | null;
    customer_effort: string | null;
    residual_loss: boolean | null;
  };
  measurement: {
    affected_accounts: number | null;
    eligible_accounts: number | null;
    affected_users: number | null;
    eligible_users: number | null;
    affected_operations: number | null;
    eligible_operations: number | null;
    affected_count: number | null;
    eligible_count: number | null;
    unit: string | null;
    window_start: string | null;
    window_end: string | null;
    limitations: string[];
  };
}

export interface ImpactEvaluation {
  ticket: { custom_id?: unknown; name?: unknown };
  classification?: string | null;
  impact: ImpactReportImpact;
}

export function buildImpactSummary<TError, TSkipped>(
  evaluations: readonly ImpactEvaluation[],
  errors: TError[] = [],
  skipped: TSkipped[] = [],
) {
  const scores = evaluations
    .map((item) => item.impact.calculation.score)
    .sort((a, b) => a - b);
  const countBy = (
    selector: (item: ImpactEvaluation) => string | null | undefined,
  ) =>
    evaluations.reduce<Record<string, number>>((counts, item) => {
      const key = selector(item) || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
  return {
    generated_at: new Date().toISOString(),
    rubric_version: evaluations[0]?.impact.rubric_version || null,
    evaluated_tickets: evaluations.length,
    skipped_tickets: skipped.length,
    failed_tickets: errors.length,
    score: {
      minimum: scores[0] ?? null,
      maximum: scores.at(-1) ?? null,
      average: scores.length
        ? round(
            scores.reduce((sum, score) => sum + score, 0) / scores.length,
            2,
          )
        : null,
      median: median(scores),
    },
    by_band: countBy((item) => item.impact.calculation.band.code),
    by_confidence: countBy((item) => item.impact.confidence),
    by_stage: countBy((item) => item.impact.stage),
    by_attribution: countBy((item) => item.impact.attribution),
    by_classification: countBy((item) => item.classification),
    skipped,
    errors,
  };
}

export function impactEvaluationsToCsv(
  evaluations: readonly ImpactEvaluation[],
): string {
  const headers = [
    'ticket_id',
    'custom_id',
    'name',
    'classification',
    'score',
    'band',
    'confidence',
    'stage',
    'attribution',
    'attribution_rationale',
    'reach',
    'functional_consequence',
    'journey_criticality',
    'duration',
    'incidence',
    'recovery_mode',
    'recovery_completeness',
    'recovery_customer_effort',
    'recovery_residual_loss',
    'affected_accounts',
    'eligible_accounts',
    'affected_users',
    'eligible_users',
    'affected_operations',
    'eligible_operations',
    'affected_count',
    'eligible_count',
    'unit',
    'window_start',
    'window_end',
    'limitations',
  ];
  const rows = evaluations.map(({ ticket, classification, impact }) => [
    impact.ticket_id,
    ticket.custom_id,
    ticket.name,
    classification,
    impact.calculation.score,
    impact.calculation.band.code,
    impact.confidence,
    impact.stage,
    impact.attribution,
    impact.attribution_rationale,
    impact.dimensions.reach.level,
    impact.dimensions.functional_consequence.level,
    impact.dimensions.journey_criticality.level,
    impact.dimensions.duration.level,
    impact.dimensions.incidence.level,
    impact.recovery.mode,
    impact.recovery.completeness,
    impact.recovery.customer_effort,
    impact.recovery.residual_loss,
    impact.measurement.affected_accounts,
    impact.measurement.eligible_accounts,
    impact.measurement.affected_users,
    impact.measurement.eligible_users,
    impact.measurement.affected_operations,
    impact.measurement.eligible_operations,
    impact.measurement.affected_count,
    impact.measurement.eligible_count,
    impact.measurement.unit,
    impact.measurement.window_start,
    impact.measurement.window_end,
    impact.measurement.limitations.join(' | '),
  ]);
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function median(scores: readonly number[]): number | null {
  if (!scores.length) return null;
  const middle = Math.floor(scores.length / 2);
  return scores.length % 2
    ? scores[middle]
    : round((scores[middle - 1] + scores[middle]) / 2, 2);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
