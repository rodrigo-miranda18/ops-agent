function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR');
}

export function parseClickUpAreaValues(
  value: string | undefined,
  legacyValue?: string,
): string[] {
  if (!value) {
    const legacy = String(legacyValue || 'EN').trim();
    return legacy ? [legacy] : ['EN'];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('CLICKUP_AREA_VALUES must be a valid JSON array');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((area) => typeof area !== 'string' || !area.trim())
  ) {
    throw new Error(
      'CLICKUP_AREA_VALUES must be a non-empty JSON array of non-empty strings',
    );
  }
  const areas = (parsed as string[]).map((area) => area.trim());
  if (new Set(areas.map(normalize)).size !== areas.length) {
    throw new Error('CLICKUP_AREA_VALUES contains duplicate normalized values');
  }
  return areas;
}

export function includesClickUpArea(
  configuredAreas: readonly string[],
  actualArea: unknown,
): boolean {
  const actual = normalize(actualArea);
  return configuredAreas.some((area) => normalize(area) === actual);
}
