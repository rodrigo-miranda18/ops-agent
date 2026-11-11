import { describe, expect, it } from 'vitest';
import { communicationSize } from './communication-size.js';

const options = [
  { id: 'nao', name: 'Não', orderindex: 0 },
  { id: 'p', name: 'P', orderindex: 1 },
  { id: 'm', name: 'M', orderindex: 2 },
  { id: 'g', name: 'G', orderindex: 3 },
  { id: 'agrupada', name: 'Comunicação agrupada', orderindex: 4 },
];

function task(value: unknown) {
  return {
    id: 't1',
    custom_fields: [
      {
        id: '00000000-0000-0000-0000-000000000004',
        name: 'Comunicação Cliente',
        value,
        type_config: { options },
      },
    ],
  };
}

describe('communicationSize', () => {
  it('lê P, M e G pelo índice ou pelo id da opção', () => {
    expect(communicationSize(task(1))).toBe('P');
    expect(communicationSize(task('m'))).toBe('M');
    expect(communicationSize(task(3))).toBe('G');
  });

  it('devolve null sem tamanho definido', () => {
    expect(communicationSize(task(0))).toBeNull();
    expect(communicationSize(task(4))).toBeNull();
    expect(communicationSize(task(undefined))).toBeNull();
    expect(communicationSize({ id: 't1' })).toBeNull();
  });
});
