import { requireGoogleChatActionUrl } from '../config/google-chat-config.js';
import type { CommunicationEvidence } from './communication-output.js';
import type { CommunicationVersionArtifacts } from './communication-artifacts.js';
import { draftMention, renderCommunicationText } from './communication-text.js';

export const COMMUNICATION_APPROVE_ACTION = 'communication_approve';

export interface CommunicationCardImage {
  url: string;
  caption: string;
}

export interface CommunicationCardInput extends CommunicationVersionArtifacts {
  communicationId: string;
  version: number;
  taskLabel: string;
}

export function buildPublicationImages(
  communicationId: string,
  version: number,
  images: CommunicationCardImage[],
) {
  if (!images.length) return {};
  return {
    cardsV2: [
      {
        cardId: `communication-${communicationId}-v${version}-images`,
        card: { sections: [{ widgets: images.map(imageWidget) }] },
      },
    ],
  };
}

export function buildCommunicationCard(
  input: CommunicationCardInput,
  actionUrl: string | undefined,
) {
  const { output } = input;
  const ready = output.status === 'READY';
  return {
    cardsV2: [
      {
        cardId: `communication-${input.communicationId}-v${input.version}`,
        card: {
          header: {
            title: `Versão ${input.version}`,
            subtitle: input.taskLabel,
          },
          sections: [
            ready
              ? {
                  header: '📝 Rascunho',
                  widgets: paragraphs(
                    renderCommunicationText(
                      output,
                      input.tickets,
                      draftMention,
                    ),
                  ),
                }
              : {
                  header: '⚠️ Contexto insuficiente',
                  widgets: paragraphs(
                    `${output.summary}\n\nResponda às dúvidas abaixo nesta thread para gerar uma nova versão.`,
                  ),
                },
            ...(ready && input.media.length
              ? [
                  {
                    header: '🖼️ Imagens',
                    widgets: input.media.map(imageWidget),
                  },
                ]
              : []),
            {
              header: '🔎 Evidências',
              collapsible: true,
              uncollapsibleWidgetsCount: 1,
              widgets: paragraphs(
                output.evidence.length
                  ? output.evidence.map(evidenceLine).join('\n')
                  : 'Nenhuma evidência informada.',
              ),
            },
            {
              header: '❓ Dúvidas',
              widgets: paragraphs(
                output.open_questions.length
                  ? output.open_questions
                      .map((question) => `• ${question}`)
                      .join('\n')
                  : 'Nenhuma.',
              ),
            },
            ...(input.warnings.length
              ? [
                  {
                    header: '⚠️ Avisos',
                    widgets: paragraphs(
                      input.warnings
                        .map((warning) => `• ${warning}`)
                        .join('\n'),
                    ),
                  },
                ]
              : []),
            ...(ready
              ? [
                  {
                    widgets: [
                      {
                        buttonList: {
                          buttons: [
                            approveButton(
                              requireGoogleChatActionUrl(actionUrl),
                              input.communicationId,
                              input.version,
                            ),
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

function imageWidget({ url, caption }: CommunicationCardImage) {
  return { image: { imageUrl: url, altText: caption } };
}

function approveButton(actionUrl: string, id: string, version: number) {
  return {
    text: 'Aprovar e publicar',
    onClick: {
      action: {
        function: actionUrl,
        parameters: [
          { key: 'action', value: COMMUNICATION_APPROVE_ACTION },
          { key: 'communicationId', value: id },
          { key: 'version', value: String(version) },
        ],
      },
    },
  };
}

const EVIDENCE_LABELS: Record<CommunicationEvidence['kind'], string> = {
  pull_request: 'PR',
  commit: 'Commit',
  code: 'Código',
};

function evidenceLine(evidence: CommunicationEvidence) {
  return `• *${EVIDENCE_LABELS[evidence.kind]}:* ${evidence.reference} — ${evidence.note}`;
}

function paragraphs(value: string) {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ textParagraph: { text: cardHtml(paragraph) } }));
}

const URL_PATTERN = /(https?:\/\/[^\s<>]+)/;

function cardHtml(value: string) {
  return value
    .split(URL_PATTERN)
    .map((part, index) => (index % 2 ? cardLink(part) : cardText(part)))
    .join('');
}

function cardLink(url: string) {
  return `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(url)}</a>`;
}

function cardText(value: string) {
  return escapeHtml(value)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
