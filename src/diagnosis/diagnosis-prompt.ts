export function renderTicketPrompt(template: string, ticket: unknown): string {
  return template.replace('{{TICKET_JSON}}', JSON.stringify(ticket, null, 2));
}
