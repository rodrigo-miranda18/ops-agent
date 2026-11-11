import { expect, it } from 'vitest';
import {
  buildDiagnosisCard as build,
  buildRemediationCard,
} from './google-chat-cards.js';

const ACTION_URL = 'https://ops.example.com/google-chat/events';

function buildDiagnosisCard(...args) {
  return build(...args, ACTION_URL);
}

const run = {
  ticket_id: '42',
  updated_at: '2026-09-20T10:00:00.000Z',
  finished_at: '2026-09-20T10:00:00.000Z',
  status: 'diagnosed',
  classification: 'bug',
  remediation_mode: 'auto',
};

const action = {
  decision: 'CORRECTION_REQUIRED',
  confidence: 'high',
  summary: 'Corrigir o cálculo do relatório',
  reason: 'O filtro de data ignora o fuso',
  repositories: [
    'service-17',
    { name: 'service-04', role: 'primary', scope: 'api' },
  ],
};

it('snapshots the ticket diagnosis card', () => {
  expect(
    buildDiagnosisCard(
      {
        id: '42',
        custom_id: 'SUP-42',
        name: 'Falha no relatório',
        description:
          '**Cliente** relata _divergência_ no relatório\n\n- item 1\n- item 2',
        url: 'https://app.clickup.com/t/42',
      },
      run,
      '## Causa\n\nO filtro `created_at` usa UTC.\n\n```ts\nconst x = 1;\n```',
      'Olá! Identificamos a causa e o time já está atuando.',
      action,
      'approval-1',
    ),
  ).toMatchSnapshot();
});

it('snapshots the ticket diagnosis card without url or gate', () => {
  expect(
    buildDiagnosisCard(
      { id: '43', name: 'Dúvida de uso', url: null },
      { ...run, classification: 'question', remediation_mode: 'manual' },
      'Sem causa técnica.',
      'Comentário.',
      {
        decision: 'NO_CODE_ACTION',
        confidence: 'low',
        summary: 'Nada a fazer',
        reason: 'Uso incorreto',
        repositories: [],
      },
      'approval-2',
    ),
  ).toMatchSnapshot();
});

it('snapshots the diagnosis card with an unresolved repository gate', () => {
  expect(
    buildDiagnosisCard(
      { id: '44', name: 'Erro no envio', url: 'https://app.clickup.com/t/44' },
      run,
      'Causa técnica',
      'Comentário',
      {
        ...action,
        repositories: ['invented-service'],
        repository_gate: 'UNRESOLVED',
        repository_gate_reason: 'Repositório não existe no workspace',
      },
      'approval-3',
    ),
  ).toMatchSnapshot();
});

it('snapshots the incident diagnosis card with reused issues', () => {
  expect(
    buildDiagnosisCard(
      {
        id: 'grafana-abc',
        name: 'Falha no envio de e-mails',
        task_type: 'incident',
        url: null,
        vectors: ['engagement'],
        github_issues: [
          {
            repository: 'service-15',
            url: 'https://github.com/Example-org/service-15/issues/7',
            reused: true,
            role: 'primary',
          },
          {
            repository: 'service-04',
            url: 'https://github.com/Example-org/service-04/issues/9',
            reused: true,
            scope: 'worker',
          },
        ],
        incident: {
          status: 'firing',
          severity: 'critical',
          startedAt: '2026-09-20T09:30:00.000Z',
          labels: { alertname: 'MailBounce', service: 'service-15' },
          annotations: { summary: 'Bounce acima de 5%' },
          generatorURL: 'https://grafana.example.com/alerting/1',
        },
      },
      run,
      'Causa técnica do incidente',
      null,
      action,
      'incident-1',
    ),
  ).toMatchSnapshot();
});

it('snapshots the incident diagnosis card with a single new issue', () => {
  expect(
    buildDiagnosisCard(
      {
        id: 'grafana-def',
        name: 'Latência alta',
        task_type: 'incident',
        url: null,
        github_issue: {
          repository: 'service-17',
          url: 'https://github.com/Example-org/service-17/issues/3',
        },
      },
      { ...run, classification: null },
      'Causa',
      null,
      { ...action, decision: 'INSUFFICIENT_EVIDENCE', confidence: 'medium' },
      'incident-2',
    ),
  ).toMatchSnapshot();
});

it('snapshots the remediation card with pull requests, superseded PRs and checks', () => {
  expect(
    buildRemediationCard(
      {
        id: '42',
        custom_id: 'SUP-42',
        name: 'Falha no relatório',
        url: 'https://app.clickup.com/t/42',
      },
      action,
      {
        status: 'pull_request_opened',
        summary: 'Corrige o fuso no filtro',
        reason: 'Causa confirmada',
        repositories: [{ name: 'service-17', changes: 'Ajusta filtro' }],
        checks: [
          { repository: 'service-17', command: 'npm test', status: 'passed' },
          {
            repository: 'service-17',
            command: 'npm run lint',
            status: 'failed',
          },
          {
            repository: 'service-17',
            command: 'npm run build',
            status: 'skipped',
          },
        ],
        pull_requests: [
          {
            repository: 'service-17',
            url: 'https://github.com/Example-org/service-17/pull/10',
            depends_on: ['service-04'],
          },
          {
            repository: 'service-04',
            url: 'https://github.com/Example-org/service-04/pull/11',
          },
          { repository: 'sem-url' },
        ],
        superseded_pull_requests: [
          {
            repository: 'service-17',
            url: 'https://github.com/Example-org/service-17/pull/8',
            status: 'closed',
            reason: 'Reorientado',
          },
        ],
      },
    ),
  ).toMatchSnapshot();
});

it('snapshots the remediation card without pull requests or ticket url', () => {
  expect(
    buildRemediationCard(
      { id: 'grafana-abc', name: 'Falha no envio', url: null },
      { ...action, decision: 'IMPROVEMENT_RECOMMENDED', repositories: [] },
      { status: 'no_changes', summary: 'Nada alterado', reason: 'Sem diff' },
    ),
  ).toMatchSnapshot();
});

it('incident card exposes the assume incident action', () => {
  const card = build(
    {
      id: 'grafana-abc',
      name: 'Falha no envio de e-mails',
      task_type: 'incident',
      github_issues: [
        {
          repository: 'service-15',
          url: 'https://github.com/Example-org/service-15/issues/7',
        },
      ],
    },
    {
      ticket_id: 'grafana-abc',
      updated_at: '2026-09-19',
      finished_at: '2026-09-19',
      status: 'diagnosed',
      classification: 'bug',
    },
    'Causa técnica',
    null,
    {
      decision: 'CORRECTION_REQUIRED',
      confidence: 'high',
      summary: 'Corrigir',
      reason: 'Bug',
      repositories: ['service-15'],
    },
    'incident-1',
    ACTION_URL,
  );
  const serialized = JSON.stringify(card);
  expect(serialized.includes('assume_incident')).toBe(true);
  expect(serialized.includes('assume_ticket')).toBe(false);
});

it('incident card omits the assume incident action when no issue was created', () => {
  const card = build(
    {
      id: 'grafana-abc',
      name: 'Falha no envio de e-mails',
      task_type: 'incident',
      github_issues: [{ repository: 'service-15', url: null }],
    },
    {
      ticket_id: 'grafana-abc',
      updated_at: '2026-09-19',
      finished_at: '2026-09-19',
      status: 'diagnosed',
      classification: 'bug',
    },
    'Causa técnica',
    null,
    {
      decision: 'CORRECTION_REQUIRED',
      confidence: 'high',
      summary: 'Corrigir',
      reason: 'Bug',
      repositories: ['service-15'],
    },
    'incident-1',
    ACTION_URL,
  );
  const serialized = JSON.stringify(card);
  expect(serialized.includes('assume_incident')).toBe(false);
  expect(serialized.includes('Assumir incidente')).toBe(false);
});

it('diagnosis card omits the conversation button and preserves ticket actions', () => {
  const card = build(
    {
      id: '42',
      name: 'Falha no relatório',
      url: 'https://app.clickup.com/t/42',
    },
    {
      ticket_id: '42',
      updated_at: '2026-08-28',
      finished_at: '2026-08-28',
      status: 'diagnosed',
      classification: 'bug',
    },
    'Causa técnica',
    'Comentário para CS',
    {
      decision: 'CORRECTION_REQUIRED',
      confidence: 'high',
      summary: 'Corrigir',
      reason: 'Bug',
      repositories: [],
    },
    'approval-1',
    ACTION_URL,
  );
  const serialized = JSON.stringify(card);
  expect(serialized.includes('Conversar sobre o diagnóstico')).toBe(false);
  expect(serialized.includes('assume_ticket')).toBe(true);
  expect(serialized.includes('approve_cs_comment')).toBe(true);
});

it('diagnosis card announces the repository gate instead of promising an automatic remediation', () => {
  const card = build(
    {
      id: '42',
      name: 'Falha no relatório',
      url: 'https://app.clickup.com/t/42',
    },
    {
      ticket_id: '42',
      updated_at: '2026-08-28',
      finished_at: '2026-08-28',
      status: 'diagnosed',
      classification: 'bug',
      remediation_mode: 'auto',
    },
    'Causa técnica',
    'Comentário para CS',
    {
      decision: 'CORRECTION_REQUIRED',
      confidence: 'high',
      summary: 'Corrigir',
      reason: 'Bug',
      repositories: ['invented-service'],
      repository_gate: 'UNRESOLVED',
      repository_gate_reason:
        'Nenhum repositório foi confirmado com confiança alta entre os candidatos disponíveis.',
    },
    'approval-1',
    ACTION_URL,
  );
  const serialized = JSON.stringify(card);
  expect(serialized.includes('Correção necessária')).toBe(true);
  expect(
    serialized.includes('A remediação será executada automaticamente'),
  ).toBe(false);
  expect(serialized).toMatch(/Nenhum reposit\u00f3rio foi confirmado/);
});
