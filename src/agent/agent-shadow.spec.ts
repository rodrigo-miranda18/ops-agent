import { describe, expect, it } from 'vitest';
import { compareShadow } from './agent-shadow.js';

const action = (decision: string, repositories: string[]) => ({
  decision,
  confidence: 'high',
  repositories,
});

describe('compareShadow', () => {
  it('compara decisão e repositórios sem depender da ordem', () => {
    expect(
      compareShadow(
        '1',
        action('NO_CODE_ACTION', ['a', 'b']),
        action('NO_CODE_ACTION', ['b', 'a']),
        null,
      ),
    ).toMatchObject({ sameDecision: true, sameRepositories: true });
  });

  it('compara repositórios pelo nome quando vêm como objetos', () => {
    const named = (name: string) => ({ name, role: name, scope: name });
    expect(
      compareShadow(
        '1',
        { decision: 'X', confidence: 'high', repositories: [named('a')] },
        { decision: 'X', confidence: 'low', repositories: [named('b')] },
        null,
      ).sameRepositories,
    ).toBe(false);
  });

  it('marca divergência quando a sombra falha', () => {
    expect(
      compareShadow('1', action('X', []), null, 'unexpected_model'),
    ).toMatchObject({
      sameDecision: false,
      sameRepositories: false,
      error: 'unexpected_model',
    });
  });
});
