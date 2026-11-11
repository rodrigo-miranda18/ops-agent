import type { RemediationMode } from '../diagnosis/diagnosis-run.js';
import { requireGoogleChatActionUrl } from '../config/google-chat-config.js';
import type {
  EngineeringAction,
  IncidentIssue,
  RemediationResult,
  StoredRun,
  StoredTicket,
} from './google-chat.types.js';

export function buildDiagnosisCard(
  ticket: StoredTicket,
  run: StoredRun,
  diagnosis: string,
  comment: string,
  engineeringAction: EngineeringAction,
  approvalId: string,
  actionUrl: string | undefined,
) {
  const ticketReference = ticket.custom_id || ticket.id;
  const actionFunction = requireGoogleChatActionUrl(actionUrl);
  const issues = incidentIssues(ticket);
  const previewText =
    ticket.task_type === 'incident'
      ? `🚨 ${ticket.name}`
      : `📍 ${ticket.name} · ${ticketReference}`;
  return {
    text: previewText,
    fallbackText: previewText,
    cardsV2: [
      {
        cardId: `diagnosis-${ticket.id}`,
        card: {
          header: {
            title: `${ticket.task_type === 'incident' ? '🚨 Incidente' : '📍 Ticket'}: ${ticket.name}`,
            subtitle: `${ticketReference} · ${classificationLabel(run.classification)}`,
          },
          sections: [
            {
              header:
                ticket.task_type === 'incident'
                  ? '📝 Resumo do incidente'
                  : '📝 Descrição do ticket',
              widgets: [
                {
                  textParagraph: {
                    text: richText(
                      ticket.task_type === 'incident'
                        ? incidentSummary(ticket, engineeringAction)
                        : ticket.description || 'Descrição não informada.',
                      3500,
                    ),
                  },
                },
              ],
            },
            {
              header: '🔎 Diagnóstico técnico',
              collapsible: true,
              uncollapsibleWidgetsCount: 1,
              widgets: richTextWidgets(diagnosis, 7000),
            },
            {
              header: '🛠 Ação do time técnico',
              collapsible: true,
              uncollapsibleWidgetsCount: 1,
              widgets: richTextWidgets(
                engineeringDecisionText(
                  engineeringAction,
                  run.remediation_mode || 'auto',
                ),
                2500,
              ),
            },
            ...(ticket.task_type === 'incident' && issues.length
              ? [
                  {
                    header: `${issues.every((issue) => issue.reused) ? '🐙 Issues no GitHub (recorrência)' : '🐙 Issues no GitHub'}${issues.length > 1 ? ` · ${issues.length} repositórios` : ''}`,
                    widgets: [
                      { textParagraph: { text: incidentIssuesText(issues) } },
                    ],
                  },
                ]
              : []),
            ...(ticket.task_type === 'incident' && issues.length
              ? [
                  {
                    widgets: [
                      {
                        buttonList: {
                          buttons: [
                            {
                              text: 'Assumir incidente',
                              onClick: {
                                action: {
                                  function: actionFunction,
                                  parameters: [
                                    {
                                      key: 'action',
                                      value: 'assume_incident',
                                    },
                                    { key: 'approvalId', value: approvalId },
                                  ],
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ]
              : []),
            ...(ticket.task_type === 'incident'
              ? []
              : [
                  {
                    header: '💬 Comentário sugerido para o CS',
                    collapsible: true,
                    uncollapsibleWidgetsCount: 1,
                    widgets: richTextWidgets(comment, 3500),
                  },
                ]),
            ...(ticket.task_type === 'incident'
              ? []
              : [
                  {
                    widgets: [
                      {
                        buttonList: {
                          buttons: [
                            {
                              text: 'Assumir ticket',
                              onClick: {
                                action: {
                                  function: actionFunction,
                                  parameters: [
                                    { key: 'action', value: 'assume_ticket' },
                                    { key: 'approvalId', value: approvalId },
                                  ],
                                },
                              },
                            },
                            {
                              text: 'Aprovar comentário no ClickUp',
                              onClick: {
                                action: {
                                  function: actionFunction,
                                  parameters: [
                                    {
                                      key: 'action',
                                      value: 'approve_cs_comment',
                                    },
                                    { key: 'approvalId', value: approvalId },
                                  ],
                                },
                              },
                            },
                            ...(ticket.url
                              ? [
                                  {
                                    text: 'Abrir ticket',
                                    onClick: {
                                      openLink: { url: ticket.url },
                                    },
                                  },
                                ]
                              : []),
                            // { text: 'Ver codex log', disabled: true },
                          ],
                        },
                      },
                    ],
                  },
                ]),
          ],
        },
      },
    ],
  };
}

export function buildRemediationCard(
  ticket: StoredTicket,
  engineeringAction: EngineeringAction,
  remediation: RemediationResult,
) {
  const pullRequests = remediation.pull_requests?.filter((pr) => pr.url) || [];
  const previewText = `🛠 ${ticket.name} · ${implementationStatusLabel(remediation.status)}`;
  return {
    text: previewText,
    fallbackText: previewText,
    cardsV2: [
      {
        cardId: `remediation-${ticket.id}`,
        card: {
          header: {
            title: `🛠 Ação técnica: ${ticket.name}`,
            subtitle: `${ticket.custom_id || ticket.id} · ${implementationStatusLabel(remediation.status)}`,
          },
          sections: [
            {
              header: 'Resultado da implementação',
              widgets: richTextWidgets(
                remediationText(engineeringAction, remediation),
                6000,
              ),
            },
            ...(pullRequests.length
              ? [
                  {
                    widgets: [
                      {
                        buttonList: {
                          buttons: pullRequests.map((pr) => ({
                            text: `Abrir PR · ${pr.repository || 'repositório'}`,
                            onClick: { openLink: { url: pr.url! } },
                          })),
                        },
                      },
                    ],
                  },
                ]
              : []),
            ...(ticket.url
              ? [
                  {
                    widgets: [
                      {
                        buttonList: {
                          buttons: [
                            {
                              text: 'Abrir ticket',
                              onClick: { openLink: { url: ticket.url } },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      },
    ],
  };
}

export function normalize(value: string) {
  return value.trim().toLocaleLowerCase('pt-BR');
}

function classificationLabel(classification: string | null) {
  const labels: Record<string, string> = {
    bug: 'Bug',
    mal_entendido: 'Mal entendido',
    mal_entendido_com_oportunidade:
      'Mal entendido com oportunidade de melhoria',
    inconclusivo: 'Inconclusivo',
  };
  return classification
    ? labels[normalize(classification)] || humanize(classification)
    : 'Sem classificação';
}

function actionRepositoryNames(action?: EngineeringAction) {
  return (action?.repositories || [])
    .map((repository) =>
      typeof repository === 'string' ? repository : repository?.name,
    )
    .filter(Boolean) as string[];
}

function remediationText(
  action: EngineeringAction,
  remediation: RemediationResult,
) {
  const repositories =
    remediation.repositories
      ?.map((repository) => repository.name)
      .filter(Boolean) || actionRepositoryNames(action);
  const checks = remediation.checks?.length
    ? remediation.checks
        .map(
          (check) =>
            `${check.repository || 'Projeto'}: ${check.command || 'verificação'} (${checkStatusLabel(check.status)})`,
        )
        .join('; ')
    : 'Nenhuma verificação registrada.';
  const prs =
    remediation.pull_requests
      ?.filter((pr) => pr.url)
      .map((pr) => `${pr.repository || 'Repositório'}: ${pr.url}`)
      .join('\n') || 'Nenhum PR aberto.';
  const superseded = remediation.superseded_pull_requests?.length
    ? remediation.superseded_pull_requests
        .map(
          (pr) =>
            `${pr.repository || 'Repositório'}: ${pr.url || 'PR desconhecido'} (${supersededStatusLabel(pr.status)})`,
        )
        .join('\n')
    : null;
  return [
    `**Decisão:** ${engineeringDecisionLabel(action.decision)} · confiança ${confidenceLabel(action.confidence)}`,
    `**Status da implementação:** ${implementationStatusLabel(remediation.status)}`,
    `**Resumo:** ${remediation.summary || action.summary}`,
    `**Repositórios afetados:** ${repositories.length ? repositories.join(', ') : 'Nenhum.'}`,
    `**Verificações:** ${checks}`,
    `**PRs:** ${prs}`,
    ...(superseded ? [`**PRs anteriores:** ${superseded}`] : []),
    `**Motivo:** ${remediation.reason || action.reason}`,
  ].join('\n\n');
}

function supersededStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    closed: 'fechado por substituição',
    already_closed: 'já estava fechado',
    merged: 'já estava merged',
    failed: 'não foi possível fechar',
  };
  return status ? labels[status] || humanize(status) : 'estado desconhecido';
}

function engineeringDecisionText(
  action: EngineeringAction,
  mode: RemediationMode,
) {
  return [
    `**Decisão:** ${engineeringDecisionLabel(action.decision)}`,
    `**Confiança:** ${confidenceLabel(action.confidence)}`,
    `**Próxima etapa:** ${engineeringNextStep(action, mode)}`,
    `**Resumo:** ${action.summary}`,
  ].join('\n\n');
}

function engineeringDecisionLabel(decision: string) {
  const labels: Record<string, string> = {
    CORRECTION_REQUIRED: 'Correção necessária',
    IMPROVEMENT_RECOMMENDED: 'Melhoria recomendada',
    NO_CODE_ACTION: 'Nenhuma ação de código necessária',
    INSUFFICIENT_EVIDENCE: 'Evidências insuficientes',
    ALREADY_FIXED: 'Correção já existente',
  };
  return labels[decision] || humanize(decision);
}

function implementationStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: 'Aguardando execução',
    PR_OPENED: 'PR aberto',
    MULTIPLE_PRS_OPENED: 'PRs abertos',
    ALREADY_FIXED: 'Correção já existente',
    PLAN_ONLY: 'Somente plano',
    IMPLEMENTATION_FAILED: 'Falha na implementação',
    BLOCKED_BY_EVIDENCE: 'Bloqueado por falta de evidências',
  };
  return labels[status] || humanize(status);
}

function confidenceLabel(confidence: string) {
  return (
    ({ low: 'baixa', medium: 'média', high: 'alta' } as Record<string, string>)[
      confidence
    ] || confidence
  );
}

function checkStatusLabel(status: string | undefined) {
  return (
    (
      {
        passed: 'aprovada',
        failed: 'falhou',
        not_run: 'não executada',
      } as Record<string, string>
    )[status || ''] || 'sem status'
  );
}

function engineeringNextStep(action: EngineeringAction, mode: RemediationMode) {
  if (mode === 'none')
    return 'A execução foi configurada somente para diagnóstico.';
  if (action.repository_gate === 'UNRESOLVED')
    return (
      action.repository_gate_reason ||
      'Nenhum repositório foi confirmado entre os candidatos disponíveis.'
    );
  if (
    mode === 'plan' &&
    ['CORRECTION_REQUIRED', 'IMPROVEMENT_RECOMMENDED'].includes(action.decision)
  )
    return 'Um plano técnico será preparado, sem alterações no código.';
  if (action.decision === 'CORRECTION_REQUIRED')
    return 'A remediação será executada automaticamente.';
  if (
    action.decision === 'IMPROVEMENT_RECOMMENDED' &&
    action.confidence === 'high'
  )
    return 'A melhoria será implementada automaticamente.';
  if (action.decision === 'IMPROVEMENT_RECOMMENDED')
    return 'A melhoria foi registrada, sem implementação automática.';
  if (action.decision === 'ALREADY_FIXED')
    return 'Nenhuma nova alteração será criada.';
  if (action.decision === 'INSUFFICIENT_EVIDENCE')
    return 'Nenhuma alteração será feita até obter evidências suficientes.';
  return 'Nenhuma alteração de código será iniciada.';
}

export function shouldNotifyRemediation(
  run: StoredRun,
  action: EngineeringAction,
) {
  if (run.remediation_iteration) return true;
  if (run.remediation_mode === 'none') return false;
  if (action.repository_gate === 'UNRESOLVED') return false;
  if (run.remediation_mode === 'plan')
    return ['CORRECTION_REQUIRED', 'IMPROVEMENT_RECOMMENDED'].includes(
      action.decision,
    );
  return (
    action.decision === 'CORRECTION_REQUIRED' ||
    (action.decision === 'IMPROVEMENT_RECOMMENDED' &&
      action.confidence === 'high')
  );
}

function humanize(value: string) {
  const text = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return text
    ? text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1)
    : 'Sem classificação';
}

function richText(value: string, limit: number) {
  const truncated =
    value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
  return truncated
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '• $1')
    .replace(/^\s*\d+[.)]\s+(.+)$/gm, '• $1')
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<font color="#5f6368">$1</font>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n/g, '<br>');
}

function richTextWidgets(value: string, limit: number) {
  const truncated =
    value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
  const paragraphs = truncated
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return (paragraphs.length ? paragraphs : ['Conteúdo não informado.']).map(
    (paragraph) => ({
      textParagraph: { text: richText(paragraph, paragraph.length) },
    }),
  );
}

export function incidentIssues(ticket: StoredTicket) {
  const issues =
    ticket.github_issues || (ticket.github_issue ? [ticket.github_issue] : []);
  return issues.filter((issue) => issue.url);
}

function incidentIssuesText(issues: IncidentIssue[]) {
  const reused = issues.filter((issue) => issue.reused);
  const preamble =
    reused.length === issues.length
      ? 'Incidente recorrente: nenhuma issue nova foi aberta, o registro existente foi atualizado com este disparo.<br>'
      : reused.length
        ? `Incidente recorrente em ${reused.length} de ${issues.length} repositórios: nesses, o registro existente foi atualizado com este disparo.<br>`
        : '';
  const lines = issues.map((issue) => {
    const label = issue.name || issue.repository;
    const role = issue.role ? ` — ${issue.role}` : '';
    return `${label ? `<b>${label}</b>${role}${issue.reused ? ' (recorrência)' : ''}: ` : ''}<a href="${issue.url}">${issue.url}</a>`;
  });
  return `${preamble}${lines.join('<br>')}`;
}

function incidentSummary(
  ticket: StoredTicket,
  engineeringAction?: EngineeringAction,
) {
  const incident = ticket.incident || {};
  const labels = incident.labels || {};
  const annotations = incident.annotations || {};
  const diagnosed = actionRepositoryNames(engineeringAction);
  const service =
    labels.service ||
    labels.ServiceName ||
    (diagnosed.length ? diagnosed.join(', ') : 'serviço não identificado');
  const route = labels.spanName || labels.route || labels.http_route;
  const status = labels.http_status_code || labels.status_code;
  const observed =
    annotations.description ||
    annotations.summary ||
    ticket.description ||
    'Alerta de produção recebido.';
  const details = [
    `Serviço afetado: ${service}.`,
    route ? `Rota: ${route}.` : null,
    status ? `Status observado: HTTP ${status}.` : null,
    `Severidade: ${incident.severity || labels.severity || 'não informada'}.`,
    `Início observado: ${incident.startedAt || 'não informado'}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const source = incident.generatorURL
    ? `Origem do alerta: ${incident.generatorURL}`
    : 'Origem do alerta: Grafana.';
  return `${observed}\n\n${details}\n${source}`;
}
