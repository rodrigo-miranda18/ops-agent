import { describe, expect, it } from 'vitest';
import {
  extractOutput,
  shouldRemediate,
  validateEngineeringAction,
} from './diagnosis-output.js';

const VECTORS = [{ name: 'Conexões', description: 'Integrações' }];

function output(classification: string, action: string, impact = '') {
  return `<!-- CLASSIFICATION: ${classification} -->
<!-- VECTOR: Conexões -->
<!-- TECHNICAL_DIAGNOSIS_START --> Técnico <!-- TECHNICAL_DIAGNOSIS_END -->
<!-- CS_COMMENT_START --> CS <!-- CS_COMMENT_END -->
${impact}
<!-- ENGINEERING_ACTION_START -->
${action}
<!-- ENGINEERING_ACTION_END -->`;
}

const ACTION =
  '```json\n{"decision":"INSUFFICIENT_EVIDENCE","confidence":"low",' +
  '"summary":"s","reason":"r","repositories":["service-15","service-15"]}\n```';

describe('extractOutput', () => {
  it('parses sections and normalizes the engineering action', () => {
    const result = extractOutput(output('INCONCLUSIVO', ACTION), VECTORS);
    expect(result).toMatchObject({
      classification: 'inconclusivo',
      vector: 'Conexões',
      technicalDiagnosis: 'Técnico',
      csComment: 'CS',
      customerImpact: null,
      engineeringAction: {
        decision: 'INSUFFICIENT_EVIDENCE',
        repositories: [{ name: 'service-15' }],
      },
    });
  });

  it('rejects output missing a required section', () => {
    expect(() => extractOutput('<!-- VECTOR: Conexões -->', VECTORS)).toThrow(
      'Codex output did not contain all required diagnosis sections',
    );
  });

  it('requires the customer impact section for bugs', () => {
    expect(() => extractOutput(output('BUG', ACTION), VECTORS)).toThrow(
      'Confirmed bug diagnosis did not contain the customer impact section',
    );
  });
});

describe('validateEngineeringAction', () => {
  it.each([
    [null, 'Invalid engineering action decision'],
    [{ decision: 'X' }, 'Invalid engineering action decision'],
    [
      { decision: 'NO_CODE_ACTION', confidence: 'x' },
      'Invalid engineering action confidence',
    ],
    [
      { decision: 'NO_CODE_ACTION', confidence: 'low', summary: 's' },
      'Engineering action must contain summary and reason',
    ],
  ])('rejects %j', (action, message) => {
    expect(() => validateEngineeringAction(action)).toThrow(message);
  });
});

describe('shouldRemediate', () => {
  const correction = {
    decision: 'CORRECTION_REQUIRED',
    confidence: 'medium',
  } as const;

  it('never remediates with mode none or an unresolved repository', () => {
    expect(shouldRemediate(correction, 'none')).toBe(false);
    expect(
      shouldRemediate({ ...correction, repository_gate: 'UNRESOLVED' }, 'auto'),
    ).toBe(false);
  });

  it('plans every actionable decision', () => {
    expect(shouldRemediate(correction, 'plan')).toBe(true);
    expect(
      shouldRemediate(
        { decision: 'ALREADY_FIXED', confidence: 'high' },
        'plan',
      ),
    ).toBe(false);
  });

  it('only auto-remediates improvements with high confidence', () => {
    expect(shouldRemediate(correction, 'auto')).toBe(true);
    expect(
      shouldRemediate(
        { decision: 'IMPROVEMENT_RECOMMENDED', confidence: 'medium' },
        'auto',
      ),
    ).toBe(false);
    expect(
      shouldRemediate(
        { decision: 'IMPROVEMENT_RECOMMENDED', confidence: 'high' },
        'auto',
      ),
    ).toBe(true);
  });
});
