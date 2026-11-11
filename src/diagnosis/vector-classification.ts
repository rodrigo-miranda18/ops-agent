export interface DiagnosisVector {
  name: string;
  description: string;
}

interface ClickUpFieldOption {
  id?: unknown;
  name?: unknown;
  label?: unknown;
}

interface ClickUpCustomField {
  id?: unknown;
  name?: unknown;
  type_config?: { options?: ClickUpFieldOption[] };
}

export interface VectorFieldTask {
  custom_fields?: unknown;
}

export interface VectorFieldUpdate {
  fieldId: string;
  value: string;
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function normalizedVectorName(value: unknown): string {
  return normalize(value).replace(/[/_-]/g, ' ').replace(/\s+/g, ' ');
}

export function parseDiagnosisVectors(
  value: string | undefined,
): DiagnosisVector[] {
  let parsed: unknown;
  if (!value) throw new Error('DIAGNOSIS_VECTORS is required');
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('DIAGNOSIS_VECTORS must be a valid JSON object');
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    !Object.keys(parsed).length
  ) {
    throw new Error('DIAGNOSIS_VECTORS must be a non-empty JSON object');
  }

  const vectors = Object.entries(parsed).map(
    ([rawName, rawDescription]: [string, unknown]) => ({
      name: String(rawName).trim(),
      description:
        typeof rawDescription === 'string' ? rawDescription.trim() : '',
    }),
  );
  if (vectors.some(({ name, description }) => !name || !description)) {
    throw new Error(
      'DIAGNOSIS_VECTORS names and descriptions must be non-empty strings',
    );
  }
  const normalizedNames = vectors.map(({ name }) => normalizedVectorName(name));
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new Error('DIAGNOSIS_VECTORS contains duplicate normalized names');
  }
  return vectors;
}

export function canonicalVector(
  value: unknown,
  vectors: readonly DiagnosisVector[],
): string {
  const normalized = normalize(value)
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ');
  const vector = vectors.find(
    ({ name }) =>
      normalizedVectorName(name) === normalizedVectorName(normalized),
  );
  if (vector) return vector.name;
  throw new Error(`Invalid diagnosed vector: ${String(value || '(empty)')}`);
}

export function extractDiagnosedVector(
  stdout: unknown,
  vectors: readonly DiagnosisVector[],
): string {
  const match = String(stdout || '').match(/<!--\s*VECTOR:\s*([^>]+?)\s*-->/i);
  if (!match)
    throw new Error('Codex output did not contain the diagnosed vector');
  return canonicalVector(match[1], vectors);
}

export function renderDiagnosisVectorPrompt(
  template: string,
  vectors: readonly DiagnosisVector[],
): string {
  const options = vectors
    .map(({ name, description }) => `- \`${name}\`: ${description}`)
    .join('\n');
  const marker = `<!-- VECTOR: ${vectors.map(({ name }) => name).join('|')} -->`;
  return template
    .replace('{{DIAGNOSIS_VECTOR_OPTIONS}}', options)
    .replace('{{DIAGNOSIS_VECTOR_MARKER}}', marker);
}

export function vectorsEqual(
  left: readonly unknown[] | null | undefined,
  right: readonly unknown[] | null | undefined,
): boolean {
  const normalized = (values: readonly unknown[] | null | undefined) =>
    [...new Set((values || []).map((value) => normalize(value)))].sort();
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export function resolveVectorFieldUpdate(
  task: VectorFieldTask | null | undefined,
  fieldId: string,
  fieldName: string,
  diagnosedVector: unknown,
  vectors: readonly DiagnosisVector[],
): VectorFieldUpdate {
  const fields = (
    Array.isArray(task?.custom_fields) ? task.custom_fields : []
  ) as ClickUpCustomField[];
  const field =
    (fieldId && fields.find((item) => item.id === fieldId)) ||
    fields.find((item) => normalize(item.name) === normalize(fieldName));
  if (!field?.id)
    throw new Error(`ClickUp custom field not found: ${fieldName}`);

  const vector = canonicalVector(diagnosedVector, vectors);
  const option = (field.type_config?.options || []).find(
    (item) => normalize(item.name || item.label) === normalize(vector),
  );
  if (!option?.id) {
    throw new Error(`ClickUp option not found for diagnosed vector: ${vector}`);
  }
  return { fieldId: String(field.id), value: String(option.id) };
}
