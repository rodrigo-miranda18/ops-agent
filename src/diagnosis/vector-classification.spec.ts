import { expect, it } from 'vitest';
import {
  canonicalVector,
  extractDiagnosedVector,
  parseDiagnosisVectors,
  renderDiagnosisVectorPrompt,
  resolveVectorFieldUpdate,
  vectorsEqual,
} from './vector-classification.js';

const configuredVectors = parseDiagnosisVectors(
  JSON.stringify({
    'Aquisição/CRM': 'captura e qualificação de leads',
    Entrega: 'processamento e entrega de campanhas',
  }),
);

it('extracts and canonicalizes the diagnosed vector marker', () => {
  expect(
    extractDiagnosedVector('<!-- VECTOR: aquisicao_crm -->', configuredVectors),
  ).toBe('Aquisição/CRM');
  expect(canonicalVector('ENTREGA', configuredVectors)).toBe('Entrega');
});

it('rejects an absent or unsupported diagnosed vector', () => {
  expect(() =>
    extractDiagnosedVector('<!-- CLASSIFICATION: BUG -->', configuredVectors),
  ).toThrow(/did not contain/);
  expect(() =>
    extractDiagnosedVector(
      '<!-- VECTOR: Produto desconhecido -->',
      configuredVectors,
    ),
  ).toThrow(/Invalid diagnosed vector/);
});

it('parses names and descriptions from DIAGNOSIS_VECTORS', () => {
  expect(configuredVectors).toStrictEqual([
    { name: 'Aquisição/CRM', description: 'captura e qualificação de leads' },
    { name: 'Entrega', description: 'processamento e entrega de campanhas' },
  ]);
});

it('rejects missing, malformed, empty, incomplete, and duplicate vector configuration', () => {
  for (const value of [
    undefined,
    '{',
    '{}',
    '{" ":"descrição"}',
    '{"Vendas":" "}',
    '{"Pós-venda":"um","pos venda":"dois"}',
  ]) {
    expect(() => parseDiagnosisVectors(value)).toThrow(/DIAGNOSIS_VECTORS/);
  }
});

it('renders configured vectors and the exact output marker in the diagnosis prompt', () => {
  const template =
    'Opções:\n{{DIAGNOSIS_VECTOR_OPTIONS}}\nSaída: {{DIAGNOSIS_VECTOR_MARKER}}';
  expect(renderDiagnosisVectorPrompt(template, configuredVectors)).toBe(
    'Opções:\n- `Aquisição/CRM`: captura e qualificação de leads\n- `Entrega`: processamento e entrega de campanhas\nSaída: <!-- VECTOR: Aquisição/CRM|Entrega -->',
  );
});

it('compares vector values without accents, case or order differences', () => {
  expect(vectorsEqual(['Sequências'], ['sequencias'])).toBe(true);
  expect(vectorsEqual(['Conexões'], ['Sequências'])).toBe(false);
});

it('resolves the ClickUp option id for the inferred vector', () => {
  const task = {
    custom_fields: [
      {
        id: 'field-id',
        name: 'Vetores',
        type_config: {
          options: [
            { id: 'sales-id', name: 'Aquisição/CRM' },
            { id: 'delivery-id', name: 'Entrega' },
          ],
        },
      },
    ],
  };
  expect(
    resolveVectorFieldUpdate(
      task,
      '',
      'Vetores',
      'aquisicao-crm',
      configuredVectors,
    ),
  ).toStrictEqual({
    fieldId: 'field-id',
    value: 'sales-id',
  });
});
