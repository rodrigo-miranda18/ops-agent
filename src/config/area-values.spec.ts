import { expect, it } from 'vitest';
import { includesClickUpArea, parseClickUpAreaValues } from './area-values.js';

it('parses multiple configured ClickUp areas', () => {
  expect(parseClickUpAreaValues('["EN", "Pós-venda"]')).toStrictEqual([
    'EN',
    'Pós-venda',
  ]);
  expect(includesClickUpArea(['EN', 'Pós-venda'], 'pos venda')).toBe(true);
  expect(includesClickUpArea(['EN', 'Pós-venda'], 'Financeiro')).toBe(false);
});

it('supports the singular area variable during migration', () => {
  expect(parseClickUpAreaValues(undefined, 'CS')).toStrictEqual(['CS']);
  expect(parseClickUpAreaValues(undefined, undefined)).toStrictEqual(['EN']);
});

it('rejects invalid, empty, and duplicate area arrays', () => {
  for (const value of [
    '{',
    '{}',
    '[]',
    '["EN", ""]',
    '["Pós-venda", "pos venda"]',
  ]) {
    expect(() => parseClickUpAreaValues(value)).toThrow(/CLICKUP_AREA_VALUES/);
  }
});
