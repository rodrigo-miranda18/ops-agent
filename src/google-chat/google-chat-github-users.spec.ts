import { expect, it } from 'vitest';
import {
  assignmentSummary,
  githubLoginForEmail,
} from './google-chat-github-users.js';

it('resolves the GitHub login ignoring e-mail case and surrounding spaces', () => {
  const map = JSON.stringify({ ' Pessoa8@Example.com ': 'dev-github' });
  expect(githubLoginForEmail('pessoa8@example.com ', map)).toBe('dev-github');
  expect(githubLoginForEmail('outrpessoa1@example.com', map)).toBe(null);
});

it('ignores a map that is not a JSON object', () => {
  expect(
    githubLoginForEmail('pessoa1@example.com', 'pessoa1@example.com:login'),
  ).toBe(null);
  expect(
    githubLoginForEmail('pessoa1@example.com', '["pessoa1@example.com"]'),
  ).toBe(null);
});

it('summarizes assigned and failed issues', () => {
  expect(assignmentSummary(null, [])).toBe(
    'Nenhum usuário do GitHub mapeado para esse e-mail; as issues seguem sem assignee.',
  );
  expect(assignmentSummary('dev', [])).toBe(
    'Nenhuma issue do GitHub vinculada a este incidente.',
  );
  expect(
    assignmentSummary('dev', [
      { repository: 'service-15', url: 'u1', status: 'assigned' },
      { url: 'u2', status: 'failed' },
    ]),
  ).toBe(
    'Issues atribuídas a @dev: service-15. Falha ao atribuir em u2; atribua manualmente.',
  );
});
