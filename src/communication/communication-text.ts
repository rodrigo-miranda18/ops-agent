import type { CommunicationOutput, LinkKind } from './communication-output.js';
import type { CommunicationTask } from './communication-store.js';
import type { ImprovementTicket } from './communication.types.js';

const LINK_EMOJIS: Record<LinkKind, string> = {
  help_center: '📚',
  video: '▶️',
  reference: '🔗',
};

export function renderCommunicationText(
  output: CommunicationOutput,
  tickets: readonly ImprovementTicket[],
  mention: (ticket: ImprovementTicket) => string,
): string {
  return [
    `*${output.title}*`,
    `• *O que mudou:* ${output.summary}`,
    ...output.changes.map(
      (change) => `   - *${change.label}:* ${change.description}`,
    ),
    `• *Na prática:* ${output.in_practice}`,
    ...tickets.map(
      (ticket) =>
        `• ${ticket.owners.length ? `Ticket de melhoria aberto por ${mention(ticket)}` : 'Ticket de melhoria (Dono não identificado)'}: ${ticket.url}`,
    ),
    ...output.links.map(
      (link) => `• ${LINK_EMOJIS[link.kind]} ${link.label}: ${link.url}`,
    ),
  ].join('\n');
}

export function draftMention(ticket: ImprovementTicket): string {
  return ticket.owners.map((owner) => `@${owner.username}`).join(', ');
}

export function publicationMention(
  ticket: ImprovementTicket,
  userNames: ReadonlyMap<string, string>,
): string {
  return ticket.owners
    .map((owner) => {
      const name = owner.email
        ? userNames.get(owner.email.toLowerCase())
        : undefined;
      return name && /^users\/\d+$/.test(name) ? `<${name}>` : owner.username;
    })
    .join(', ');
}

export function communicationTaskLabel(task: CommunicationTask): string {
  const id = task.customId || task.id;
  return task.name ? `${id} — ${task.name}` : id;
}
