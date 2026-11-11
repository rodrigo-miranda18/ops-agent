import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseImpactArgs } from './impact-args.js';

const projectDir = '/app';

describe('parseImpactArgs', () => {
  it('avalia um ticket a partir de results/ por padrão', () => {
    expect(parseImpactArgs(['--ticket-id= 86a1 '], projectDir)).toEqual({
      all: false,
      force: false,
      concurrency: 1,
      ticketId: '86a1',
      source: '/app/results',
      output: null,
    });
  });

  it('deriva o diretório de saída do histórico a partir da origem', () => {
    const args = parseImpactArgs(
      ['--all', '--source=/data/backfill', '--concurrency=4', '--force'],
      projectDir,
    );
    expect(args).toMatchObject({
      all: true,
      force: true,
      concurrency: 4,
      source: '/data/backfill',
      output: path.join('/app/results', 'impact-v1.1-backfill'),
    });
  });

  it('exige exatamente um de --all ou --ticket-id, exceto com --help', () => {
    expect(() => parseImpactArgs([], projectDir)).toThrow(
      'Use exactly one of --all or --ticket-id',
    );
    expect(() =>
      parseImpactArgs(['--all', '--ticket-id=1'], projectDir),
    ).toThrow('Use exactly one of --all or --ticket-id');
    expect(() => parseImpactArgs(['--ticket-id= '], projectDir)).toThrow(
      'Use exactly one of --all or --ticket-id',
    );
    expect(parseImpactArgs(['-h'], projectDir).help).toBe(true);
  });

  it('rejeita concorrência fora de 1..8 e argumentos desconhecidos', () => {
    expect(() =>
      parseImpactArgs(['--all', '--concurrency=9'], projectDir),
    ).toThrow('--concurrency must be an integer from 1 to 8');
    expect(() => parseImpactArgs(['--nope'], projectDir)).toThrow(
      'Unknown argument: --nope',
    );
  });
});
