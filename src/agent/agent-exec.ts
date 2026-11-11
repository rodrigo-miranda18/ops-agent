import { runClaudeExec } from '../claude/claude.js';
import {
  runCodexExec,
  type CodexExecOptions,
  type CodexExecResult,
} from '../codex/codex.js';
import type { AgentConfig } from '../config/agent-config.js';
import type { AgentProfile, AgentSurface } from './agent-runtime.js';

export interface AgentExecOptions extends CodexExecOptions {
  surface: AgentSurface;
  profile: AgentProfile;
  agent?: AgentConfig;
}

export async function runAgentExec(
  options: AgentExecOptions,
): Promise<CodexExecResult> {
  const { surface, profile, agent, ...codex } = options;
  if (agent?.runtimes[surface] !== 'claude') return runCodexExec(codex);
  return runClaudeExec({
    claude: agent.claude,
    cwd: codex.cwd,
    env: codex.env,
    timeoutMs: codex.timeoutMs,
    prompt: codex.prompt,
    addDir: codex.addDir,
    profile,
    imagePaths: codex.imagePaths,
  });
}
