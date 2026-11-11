import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAGNOSIS_ENV_FILES } from '../config/runner-config.js';

type Sections = Map<string, Map<string, string>>;

function parseSections(file: string): Sections {
  const sections: Sections = new Map();
  let current = new Map<string, string>();
  sections.set('', current);
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const entry = /^("[^"]*"|[^=\s]+)\s*=\s*(.+)$/.exec(line);
    if (entry) current.set(entry[1].replace(/^"|"$/g, ''), entry[2]);
  }
  return sections;
}

function section(sections: Sections, name: string) {
  return Object.fromEntries(sections.get(name) ?? new Map<string, string>());
}

const DEBUG = 'permissions.driva-debug-read-network';
const COMMUNICATION = 'permissions.driva-communication-read-network';
const CONFIG_FILES = [
  ['produção', '../../docker/codex/config.toml'],
  ['local', '../../.codex/config.toml'],
] as const;

describe.each(CONFIG_FILES)(
  'perfil de permissões da comunicação (%s)',
  (_label, relative) => {
    const sections = parseSections(new URL(relative, import.meta.url).pathname);

    it('nega leitura de .env nas raízes do workspace', () => {
      expect(
        section(sections, `${COMMUNICATION}.filesystem.":workspace_roots"`),
      ).toEqual({
        '.': '"read"',
        '**/.env': '"deny"',
      });
    });

    it('limita a varredura do glob ao fundo dos .env materializados', () => {
      const depth = Number(
        section(sections, `${COMMUNICATION}.filesystem`).glob_scan_max_depth,
      );
      const deepest = Math.max(
        ...DIAGNOSIS_ENV_FILES.map(
          (definition) =>
            path.relative('/repos', definition.filename('/repos')).split('/')
              .length,
        ),
      );
      expect(depth).toBeGreaterThanOrEqual(deepest);
    });

    it('espelha o restante do perfil de diagnóstico', () => {
      const debugFilesystem = section(sections, `${DEBUG}.filesystem`);
      expect(debugFilesystem[':workspace_roots']).toBe('"read"');
      const { ':workspace_roots': _roots, ...debugRest } = debugFilesystem;
      const { glob_scan_max_depth: _depth, ...communicationRest } = section(
        sections,
        `${COMMUNICATION}.filesystem`,
      );
      expect(communicationRest).toEqual(debugRest);
      expect(section(sections, `${COMMUNICATION}.network`)).toEqual(
        section(sections, `${DEBUG}.network`),
      );
      expect(section(sections, `${COMMUNICATION}.network.domains`)).toEqual(
        section(sections, `${DEBUG}.network.domains`),
      );
    });
  },
);

describe('arquivos .env materializados', () => {
  it('são todos cobertos pelo glob **/.env', () => {
    for (const definition of DIAGNOSIS_ENV_FILES)
      expect(path.basename(definition.filename('/repos'))).toBe('.env');
  });
});
