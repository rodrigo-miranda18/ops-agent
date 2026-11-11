import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeConfig } from '../config/agent-config.js';
import {
  claudeArgs,
  claudeEnvironment,
  claudeExecOutcome,
  claudePrompt,
  findEnvFiles,
  parseClaudeStream,
  readSandboxArgs,
} from './claude.js';

const claude: ClaudeConfig = {
  bin: 'claude',
  model: 'claude/claude-opus-5-5',
  smallModel: 'claude/claude-haiku-5-5',
  effort: 'high',
  baseUrl: 'http://proxy:8317',
  authToken: 'proxy-key',
  skillsDir: '/skills',
  hiddenPaths: ['/app/secrets'],
  writablePaths: ['/app/state/dependency-cache'],
  readOnlyPaths: [],
};

const stream = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join('\n');
const assistant = (model: string, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { model },
});
const result = (text: string, isError = false) => ({
  type: 'result',
  result: text,
  is_error: isError,
  usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4 },
});

describe('claude adapter', () => {
  it('adapta referências de skill e lista imagens no prompt', () => {
    const prompt = claudePrompt(
      'Use $driva-debug em `$CODEX_HOME/skills/driva-debug/SKILL.md`',
      ['/a.png'],
    );
    expect(prompt).toContain('Use a skill driva-debug em');
    expect(prompt).toContain('$CLAUDE_CONFIG_DIR/skills/driva-debug');
    expect(prompt).toContain('- /a.png');
    expect(prompt).not.toContain('$CODEX_HOME');
    expect(prompt).toContain('português do Brasil');
  });

  it('restringe tools na leitura e só libera permissões no perfil full', () => {
    const read = claudeArgs({ claude, addDir: '/r', profile: 'read' });
    expect(read).toEqual(
      expect.arrayContaining(['--tools', 'Bash,Read,Glob,Grep,Skill']),
    );
    expect(read).not.toContain('bypassPermissions');
    expect(claudeArgs({ claude, addDir: '/r', profile: 'full' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
    );
  });

  it('troca a credencial do proxy e isola HOME só fora do perfil full', () => {
    const env = {
      HOME: '/home/app',
      DRIVA_PROXY_API_KEY: 'x',
      CODEX_HOME: '/c',
    };
    const read = claudeEnvironment({ claude, env, profile: 'read' }, '/run');
    expect(read).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'proxy-key',
      HOME: '/run/user',
      GIT_CONFIG_GLOBAL: '/home/app/.gitconfig',
      CLAUDE_CONFIG_DIR: '/run/config',
    });
    expect(read).not.toHaveProperty('DRIVA_PROXY_API_KEY');
    expect(read).not.toHaveProperty('CODEX_HOME');
    expect(
      claudeEnvironment({ claude, env, profile: 'full' }, '/run').HOME,
    ).toBe('/home/app');
  });

  it('esconde segredos antes de reabrir o cache gravável', () => {
    const args = readSandboxArgs({
      home: '/tmp/run',
      cwd: '/app/repos',
      hiddenPaths: ['/app/state'],
      writablePaths: ['/app/state/dependency-cache'],
      readablePaths: [],
      maskedFiles: ['/app/repos/a/.env'],
    });
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args.indexOf('/app/state')).toBeLessThan(
      args.indexOf('/app/state/dependency-cache'),
    );
    expect(args).toEqual(
      expect.arrayContaining(['--ro-bind', '/dev/null', '/app/repos/a/.env']),
    );
    expect(args.at(-1)).toBe('--');
  });

  it('extrai texto, modelos e usage, ignorando linhas e subagentes', () => {
    const summary = parseClaudeStream(
      `lixo\n${stream(assistant('claude-opus-5-5'), assistant('claude-haiku-5-5', 'tool'), result('ok'))}`,
    );
    expect(summary).toEqual({
      text: 'ok',
      isError: false,
      servedModels: ['claude-opus-5-5'],
      usage: { input: 2, output: 3, cacheRead: 4 },
    });
  });

  it('preserva a resposta principal quando um comando em background gera outro result', () => {
    const summary = parseClaudeStream(
      stream(
        assistant('claude-opus-5-5'),
        result('<!-- ENGINEERING_ACTION_START -->diagnóstico'),
        result('O comando em background terminou.'),
      ),
    );

    expect(summary.isError).toBe(false);
    expect(summary.text).toContain('<!-- ENGINEERING_ACTION_START -->');
    expect(summary.text).toContain('O comando em background terminou.');
  });

  it('não descarta a resposta principal quando um result tardio falha', () => {
    const summary = parseClaudeStream(
      stream(
        assistant('claude-opus-5-5'),
        result('diagnóstico'),
        result('Usage limit reached', true),
      ),
    );

    expect(summary.isError).toBe(false);
    expect(summary.text).toBe('diagnóstico');
  });

  it('trata saída sem evento result como erro', () => {
    expect(parseClaudeStream('').isError).toBe(true);
  });

  it('aceita o modelo pedido e descarta a saída de outro modelo', () => {
    const served = (model: string) =>
      parseClaudeStream(stream(assistant(model), result('saída')));
    expect(
      claudeExecOutcome(served('claude-opus-5-5'), claude.model, 0),
    ).toMatchObject({ exitCode: 0, stdout: 'saída' });
    const downgraded = claudeExecOutcome(
      served('claude-opus-4-8'),
      claude.model,
      0,
    );
    expect(downgraded).toMatchObject({ exitCode: 1, stdout: '' });
    expect(downgraded.diagnostics).toContain('unexpected_model');
  });

  it('classifica limite do plano com erro claro', () => {
    const outcome = claudeExecOutcome(
      parseClaudeStream(stream(result('Usage limit reached', true))),
      claude.model,
      1,
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.diagnostics).toMatch(/^rate_limited: Usage limit reached/);
  });

  it('acha .env até a profundidade e ignora node_modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'env-scan-'));
    try {
      await mkdir(path.join(root, 'a/b'), { recursive: true });
      await mkdir(path.join(root, 'node_modules/x'), { recursive: true });
      await writeFile(path.join(root, 'a/b/.env'), 'X=1');
      await writeFile(path.join(root, 'node_modules/x/.env'), 'X=1');
      expect(await findEnvFiles(root)).toEqual([path.join(root, 'a/b/.env')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
