import { describe, expect, it } from 'vitest';
import { agentConfigFromEnv } from './agent-config.js';

describe('agentConfigFromEnv', () => {
  it('mantém Codex como padrão em todas as superfícies', () => {
    expect(new Set(Object.values(agentConfigFromEnv({}).runtimes))).toEqual(
      new Set(['codex']),
    );
  });

  it('permite virar uma superfície por vez', () => {
    const { runtimes } = agentConfigFromEnv({
      AGENT_RUNTIME_CONVERSATION: 'claude',
      DRIVA_PROXY_API_KEY: 'x',
    });
    expect(runtimes.conversation).toBe('claude');
    expect(runtimes.diagnosis).toBe('codex');
  });

  it('usa a rota do proxy que serve o Opus 5.5', () => {
    expect(agentConfigFromEnv({}).claude.model).toBe('claude/claude-opus-5-5');
  });

  it('recusa runtime inválido e Claude sem credencial', () => {
    expect(() => agentConfigFromEnv({ AGENT_RUNTIME: 'gpt' })).toThrow(
      'Invalid AGENT_RUNTIME',
    );
    expect(() => agentConfigFromEnv({ AGENT_RUNTIME: 'claude' })).toThrow(
      'DRIVA_PROXY_API_KEY',
    );
  });
});
