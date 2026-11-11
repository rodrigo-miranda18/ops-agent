import { describe, expect, it } from 'vitest';
import { clickUpCommandError, parseClickUpLink } from './clickup-link.js';

describe('parseClickUpLink', () => {
  it('parses a task link with and without team id', () => {
    expect(parseClickUpLink('/x https://app.clickup.com/t/86abc')).toEqual({
      taskId: '86abc',
    });
    expect(
      parseClickUpLink('https://app.clickup.com/t/9013/TICKET-1).'),
    ).toEqual({ teamId: '9013', taskId: 'TICKET-1' });
  });

  it('rejects missing or unrecognized links', () => {
    expect(() => parseClickUpLink('/comunicacao')).toThrow(
      'Envie um link válido do ClickUp após o comando.',
    );
    expect(() => parseClickUpLink('https://app.clickup.com/v/li/123')).toThrow(
      'O formato do link do ClickUp não é reconhecido.',
    );
  });
});

describe('clickUpCommandError', () => {
  it('maps ClickUp API errors to user messages', () => {
    expect(clickUpCommandError(new Error('ClickUp API 404: x'))).toBe(
      'Não encontrei esse ticket no ClickUp.',
    );
    expect(clickUpCommandError(new Error('ClickUp API 500: x'))).toBe(
      'Não foi possível consultar esse ticket no ClickUp agora.',
    );
    expect(clickUpCommandError(new Error('outro'))).toBe('outro');
  });
});
