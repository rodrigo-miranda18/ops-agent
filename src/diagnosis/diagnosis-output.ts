import {
  calculateCustomerImpact,
  type CustomerImpact,
} from '../impact/customer-impact.js';
import {
  incidentActionRepositories,
  type IncidentRepositoryEntry,
} from '../incidents/repository-selection.js';
import type { RemediationMode } from './diagnosis-run.js';
import {
  isConfidenceLevel,
  isEngineeringDecision,
  type ConfidenceLevel,
  type EngineeringDecision,
} from './engineering-action.js';
import {
  extractDiagnosedVector,
  type DiagnosisVector,
} from './vector-classification.js';

export interface EngineeringAction {
  [key: string]: unknown;
  decision: EngineeringDecision;
  confidence: ConfidenceLevel;
  summary: string;
  reason: string;
  repositories: IncidentRepositoryEntry[];
  repository_gate?: unknown;
}

export interface DiagnosisOutput {
  classification: string;
  vector: string;
  technicalDiagnosis: string;
  csComment: string;
  customerImpact: CustomerImpact | null;
  engineeringAction: EngineeringAction;
}

const CLASSIFICATION_PATTERN =
  /<!--\s*CLASSIFICATION:\s*(BUG|MAL_ENTENDIDO|MAL_ENTENDIDO_COM_OPORTUNIDADE|INCONCLUSIVO)\s*-->/i;
const TECHNICAL_DIAGNOSIS_PATTERN =
  /<!--\s*TECHNICAL_DIAGNOSIS_START\s*-->([\s\S]*?)<!--\s*TECHNICAL_DIAGNOSIS_END\s*-->/i;
const CS_COMMENT_PATTERN =
  /<!--\s*CS_COMMENT_START\s*-->([\s\S]*?)<!--\s*CS_COMMENT_END\s*-->/i;
const CUSTOMER_IMPACT_PATTERN =
  /<!--\s*CUSTOMER_IMPACT_START\s*-->([\s\S]*?)<!--\s*CUSTOMER_IMPACT_END\s*-->/i;
const ENGINEERING_ACTION_PATTERN =
  /<!--\s*ENGINEERING_ACTION_START\s*-->([\s\S]*?)<!--\s*ENGINEERING_ACTION_END\s*-->/i;

const NON_ACTIONABLE_PLAN_DECISIONS: readonly EngineeringDecision[] = [
  'INSUFFICIENT_EVIDENCE',
  'NO_CODE_ACTION',
  'ALREADY_FIXED',
];

function parseJsonSection(section: string): unknown {
  return JSON.parse(section.trim().replace(/^```json\s*|\s*```$/g, ''));
}

export function extractOutput(
  stdout: string,
  diagnosisVectors: readonly DiagnosisVector[],
): DiagnosisOutput {
  const classificationMatch = stdout.match(CLASSIFICATION_PATTERN);
  const technicalMatch = stdout.match(TECHNICAL_DIAGNOSIS_PATTERN);
  const csMatch = stdout.match(CS_COMMENT_PATTERN);
  const customerImpactMatch = stdout.match(CUSTOMER_IMPACT_PATTERN);
  const actionMatch = stdout.match(ENGINEERING_ACTION_PATTERN);
  if (!classificationMatch || !technicalMatch || !csMatch || !actionMatch) {
    throw new Error(
      'Codex output did not contain all required diagnosis sections',
    );
  }
  const classification = classificationMatch[1].toLocaleLowerCase('pt-BR');
  let customerImpactSection: string | null = null;
  if (classification === 'bug') {
    if (!customerImpactMatch) {
      throw new Error(
        'Confirmed bug diagnosis did not contain the customer impact section',
      );
    }
    customerImpactSection = customerImpactMatch[1];
  }
  const engineeringAction = validateEngineeringAction(
    parseJsonSection(actionMatch[1]),
  );
  return {
    classification,
    vector: extractDiagnosedVector(stdout, diagnosisVectors),
    technicalDiagnosis: technicalMatch[1].trim(),
    csComment: csMatch[1].trim(),
    customerImpact:
      customerImpactSection === null
        ? null
        : calculateCustomerImpact(parseJsonSection(customerImpactSection)),
    engineeringAction,
  };
}

export function validateEngineeringAction(action: unknown): EngineeringAction {
  if (
    typeof action !== 'object' ||
    action === null ||
    !('decision' in action) ||
    !isEngineeringDecision(action.decision)
  ) {
    throw new Error('Invalid engineering action decision');
  }
  if (!('confidence' in action) || !isConfidenceLevel(action.confidence)) {
    throw new Error('Invalid engineering action confidence');
  }
  if (
    !('summary' in action) ||
    typeof action.summary !== 'string' ||
    !('reason' in action) ||
    typeof action.reason !== 'string'
  ) {
    throw new Error('Engineering action must contain summary and reason');
  }
  const validated = action as EngineeringAction;
  validated.repositories = incidentActionRepositories(validated);
  return validated;
}

export function shouldRemediate(
  action: Pick<EngineeringAction, 'decision' | 'confidence'> & {
    repository_gate?: unknown;
  },
  mode: RemediationMode,
): boolean {
  if (mode === 'none') return false;
  if (action.repository_gate === 'UNRESOLVED') return false;
  if (mode === 'plan') {
    return !NON_ACTIONABLE_PLAN_DECISIONS.includes(action.decision);
  }
  return (
    action.decision === 'CORRECTION_REQUIRED' ||
    (action.decision === 'IMPROVEMENT_RECOMMENDED' &&
      action.confidence === 'high')
  );
}
