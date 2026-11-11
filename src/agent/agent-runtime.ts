export const AGENT_RUNTIMES = ['codex', 'claude'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const AGENT_SURFACES = [
  'diagnosis',
  'remediation',
  'conversation',
  'communication',
  'impact',
] as const;
export type AgentSurface = (typeof AGENT_SURFACES)[number];

export const AGENT_PROFILES = ['read', 'communication', 'full'] as const;
export type AgentProfile = (typeof AGENT_PROFILES)[number];

export function isAgentRuntime(value: string): value is AgentRuntime {
  return (AGENT_RUNTIMES as readonly string[]).includes(value);
}
