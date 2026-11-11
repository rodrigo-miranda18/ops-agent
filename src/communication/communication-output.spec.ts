import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCommunicationOutput } from './communication-output.js';

function fixture(name: string): Record<string, unknown> {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}

describe('parseCommunicationOutput', () => {
  it('accepts the ready fixture', () => {
    const output = parseCommunicationOutput(fixture('ready'));
    expect(output.status).toBe('READY');
    expect(output.title).toBe('📁 Exportar conversas para Excel (.xlsx)');
    expect(output.changes).toEqual([]);
    expect(output.links[0]?.kind).toBe('help_center');
    expect(output.pull_request_source).toBe('CITED');
    expect(output.evidence[0]?.kind).toBe('pull_request');
  });

  it('accepts insufficient context without changes', () => {
    const output = parseCommunicationOutput(fixture('insufficient'));
    expect(output.status).toBe('INSUFFICIENT_CONTEXT');
    expect(output.changes).toEqual([]);
    expect(output.open_questions).toHaveLength(1);
  });

  it('requires a non-empty in_practice even when INSUFFICIENT_CONTEXT', () => {
    expect(() =>
      parseCommunicationOutput({ ...fixture('insufficient'), in_practice: '' }),
    ).toThrow('Communication in_practice must be a non-empty string');
  });

  it('rejects an unknown link kind', () => {
    expect(() => parseCommunicationOutput(fixture('invalid'))).toThrow(
      'Invalid communication links[0].kind',
    );
  });

  it('rejects a link that is not https', () => {
    expect(() =>
      parseCommunicationOutput({
        ...fixture('ready'),
        links: [{ kind: 'video', label: 'Vídeo', url: 'javascript:alert(1)' }],
      }),
    ).toThrow('Communication links[0].url must be an https URL');
  });

  it('reads legacy output with changes and without links', () => {
    const { links: _links, ...legacy } = fixture('ready');
    const output = parseCommunicationOutput({
      ...legacy,
      changes: [{ label: 'Sem paginação', description: 'vêm todas.' }],
    });
    expect(output.links).toEqual([]);
    expect(output.changes).toHaveLength(1);
  });

  it('rejects an empty title', () => {
    expect(() =>
      parseCommunicationOutput({ ...fixture('ready'), title: '  ' }),
    ).toThrow('Communication title must be a non-empty string');
  });

  it('rejects unknown status, source and evidence kind', () => {
    expect(() =>
      parseCommunicationOutput({ ...fixture('ready'), status: 'DONE' }),
    ).toThrow('Invalid communication status');
    expect(() =>
      parseCommunicationOutput({
        ...fixture('ready'),
        pull_request_source: 'GUESSED',
      }),
    ).toThrow('Invalid communication pull_request_source');
    expect(() =>
      parseCommunicationOutput({
        ...fixture('ready'),
        evidence: [{ kind: 'log', reference: 'x', note: 'y' }],
      }),
    ).toThrow('Invalid communication evidence[0].kind');
  });

  it('rejects a non-object output', () => {
    expect(() => parseCommunicationOutput(null)).toThrow(
      'Communication output must be an object',
    );
  });

  it('never rejects an output because of images', () => {
    const base = fixture('ready') as Record<string, unknown>;
    expect(parseCommunicationOutput({ ...base, images: 'x' }).images).toEqual(
      [],
    );
    const { images: _ignored, ...legacy } = base;
    expect(parseCommunicationOutput(legacy).images).toEqual([]);
    expect(
      parseCommunicationOutput({
        ...base,
        images: [
          { index: 2, caption: ' Tela ' },
          { index: 0, caption: 'x' },
          { index: 1.5, caption: 'x' },
          { index: 3, caption: '' },
          'x',
        ],
      }).images,
    ).toEqual([{ index: 2, caption: 'Tela' }]);
  });
});
