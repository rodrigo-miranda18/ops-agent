export interface ParsedClickUpLink {
  taskId: string;
  teamId?: string;
}

export function parseClickUpLink(text: string): ParsedClickUpLink {
  const match = text.match(/https:\/\/app\.clickup\.com\/[^\s>|]+/i);
  if (!match)
    throw new Error('Envie um link válido do ClickUp após o comando.');
  const url = new URL(match[0].replace(/[),.;]+$/, ''));
  if (url.hostname !== 'app.clickup.com')
    throw new Error('O link precisa ser do app.clickup.com.');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 't' || !parts[1])
    throw new Error('O formato do link do ClickUp não é reconhecido.');
  if (parts.length >= 3) {
    if (!/^\d+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
      throw new Error('O formato do link do ClickUp não é reconhecido.');
    }
    return { teamId: parts[1], taskId: parts[2] };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1]))
    throw new Error('O formato do link do ClickUp não é reconhecido.');
  return { taskId: parts[1] };
}

export function clickUpCommandError(error: unknown): string {
  const message = (error as Error).message || '';
  if (message.startsWith('ClickUp API 404'))
    return 'Não encontrei esse ticket no ClickUp.';
  if (message.startsWith('ClickUp API'))
    return 'Não foi possível consultar esse ticket no ClickUp agora.';
  return message || 'Não foi possível processar esse comando.';
}
