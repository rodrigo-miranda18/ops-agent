import path from 'node:path';
import {
  AGENT_SURFACES,
  isAgentRuntime,
  type AgentRuntime,
  type AgentSurface,
} from '../agent/agent-runtime.js';
import type { Environment } from './env.js';

const DEFAULT_CLAUDE_BASE_URL = 'http://vpn-host2.example.internal:8317';
const DEFAULT_CLAUDE_MODEL = 'claude/claude-opus-5-5';
const DEFAULT_CLAUDE_SMALL_MODEL = 'claude/claude-haiku-5-5';
const DEFAULT_CLAUDE_EFFORT = 'high';

export interface ClaudeConfig {
  bin: string;
  model: string;
  smallModel: string;
  effort: string;
  baseUrl: string;
  authToken: string;
  skillsDir: string;
  hiddenPaths: string[];
  writablePaths: string[];
  readOnlyPaths: string[];
}

export interface AgentConfig {
  runtimes: Record<AgentSurface, AgentRuntime>;
  claude: ClaudeConfig;
}

function parseRuntime(name: string, value: string): AgentRuntime {
  if (!isAgentRuntime(value)) throw new Error(`Invalid ${name}: ${value}`);
  return value;
}

function surfaceVariable(surface: AgentSurface) {
  return `AGENT_RUNTIME_${surface.toUpperCase()}`;
}

export function agentConfigFromEnv(
  env: Environment = process.env,
): AgentConfig {
  const fallback = parseRuntime(
    'AGENT_RUNTIME',
    env.AGENT_RUNTIME?.trim() || 'codex',
  );
  const runtimes = Object.fromEntries(
    AGENT_SURFACES.map((surface) => {
      const name = surfaceVariable(surface);
      const value = env[name]?.trim();
      return [surface, value ? parseRuntime(name, value) : fallback];
    }),
  ) as Record<AgentSurface, AgentRuntime>;
  const authToken = env.DRIVA_PROXY_API_KEY?.trim() || '';
  if (Object.values(runtimes).includes('claude') && !authToken)
    throw new Error('DRIVA_PROXY_API_KEY is required for the Claude runtime');
  const codexHome =
    env.CODEX_HOME || path.join(env.DRIVA_REPOS_DIR || 'repos', '.codex');
  return {
    runtimes,
    claude: {
      bin: env.CLAUDE_BIN || 'claude',
      model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
      smallModel: env.CLAUDE_SMALL_MODEL || DEFAULT_CLAUDE_SMALL_MODEL,
      effort: env.CLAUDE_EFFORT || DEFAULT_CLAUDE_EFFORT,
      baseUrl: env.CLAUDE_BASE_URL || DEFAULT_CLAUDE_BASE_URL,
      authToken,
      skillsDir: path.join(codexHome, 'skills'),
      hiddenPaths: ['/app/secrets', '/app/state'],
      writablePaths: ['/app/state/dependency-cache'],
      readOnlyPaths: (env.CLAUDE_READ_ONLY_PATHS || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    },
  };
}
