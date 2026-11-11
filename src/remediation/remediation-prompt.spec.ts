import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderTicketPrompt } from '../diagnosis/diagnosis-prompt.js';
import { renderRemediationPrompt } from './remediation-prompt.js';
import { remediationBranchName } from './remediation-run.js';

const remediationTemplate = readFileSync(
  new URL('../prompts/remediation-prompt.md', import.meta.url),
  'utf8',
);

describe('renderRemediationPrompt', () => {
  it('fills every placeholder of the shipped template', () => {
    const prompt = renderRemediationPrompt(remediationTemplate, {
      mode: 'auto',
      worktreesDir: '/tmp/worktrees',
      branchName: 'fix/driva-ops-T1-abc',
      ticket: { id: 'T1' },
      action: { decision: 'CORRECTION_REQUIRED' },
    });
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(prompt).toContain('Modo solicitado: auto');
    expect(prompt).toContain('`/tmp/worktrees`');
    expect(prompt).toContain('"id": "T1"');
    expect(prompt).toContain('(não é uma reorientação)');
  });

  it('requires the rules of each changed repository before planning', () => {
    const rulesStep = remediationTemplate.indexOf('Regras de cada repositório');
    expect(rulesStep).toBeGreaterThan(-1);
    expect(rulesStep).toBeLessThan(
      remediationTemplate.indexOf('Crie um plano curto'),
    );

    const rules = remediationTemplate.slice(rulesStep);
    expect(rules).toContain('`AGENTS.md`');
    expect(rules).toContain('`CLAUDE.md`');
    expect(rules).toContain('comentários');
    expect(rules).toContain('`git diff`');
  });

  it('includes the reorientation context', () => {
    const prompt = renderRemediationPrompt(
      '{{REORIENTATION_INSTRUCTION}}|{{PREVIOUS_REMEDIATION_JSON}}',
      {
        mode: 'auto',
        worktreesDir: '/w',
        branchName: 'fix/driva-ops-T1-abc',
        ticket: {},
        action: {},
        instruction: 'use o outro repo',
        previousRemediation: { status: 'PR_OPENED' },
      },
    );
    expect(prompt).toBe('use o outro repo|{\n  "status": "PR_OPENED"\n}');
  });
});

describe('remediationBranchName', () => {
  it('is stable for the same cause and distinct for a reorientation', () => {
    const ticket = { id: 'T/1' };
    const action = {
      decision: 'CORRECTION_REQUIRED',
      confidence: 'high',
      summary: 'fix',
      reason: 'cause',
      repositories: [],
    } as const;

    expect(remediationBranchName(ticket, action)).toBe(
      remediationBranchName(ticket, action),
    );
    expect(remediationBranchName(ticket, action, { branchKey: 'r1' })).not.toBe(
      remediationBranchName(ticket, action, { branchKey: 'r2' }),
    );
  });
});

describe('renderTicketPrompt', () => {
  it('embeds the ticket as indented JSON', () => {
    expect(renderTicketPrompt('T: {{TICKET_JSON}}', { id: 'T1' })).toBe(
      'T: {\n  "id": "T1"\n}',
    );
  });
});
