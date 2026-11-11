import { expect, it } from 'vitest';
import {
  incidentActionRepositories,
  selectIncidentRepositories,
  githubSlug,
} from './repository-selection.js';

it('selects the exact repository from the object included in diagnosis context', () => {
  // Arrange
  const candidate = { name: 'service-15', path: '/repos/service-15' };
  const context = { repositories: [candidate], service_map: 'map' };
  // Act
  const selected = selectIncidentRepositories(
    { repositories: ['service-15'], confidence: 'high' },
    context,
  );
  // Assert
  expect(selected).toStrictEqual([{ ...candidate, role: null, scope: null }]);
});

it('selects every affected repository keeping the role and scope of each one', () => {
  // Arrange
  const context = {
    repositories: [
      { name: 'service-15', path: '/repos/service-15' },
      { name: 'service-04', path: '/repos/service-04' },
    ],
  };
  const action = {
    confidence: 'high',
    repositories: [
      {
        name: 'service-04',
        role: 'origem',
        scope: 'Gera o link com sufixo inválido',
      },
      {
        name: 'service-15',
        role: 'consumidor',
        scope: 'Rejeita o parâmetro com 5xx',
      },
    ],
  };
  // Act
  const selected = selectIncidentRepositories(action, context);
  // Assert
  expect(
    selected.map((entry) => [entry.name, entry.path, entry.role, entry.scope]),
  ).toStrictEqual([
    [
      'service-04',
      '/repos/service-04',
      'origem',
      'Gera o link com sufixo inválido',
    ],
    [
      'service-15',
      '/repos/service-15',
      'consumidor',
      'Rejeita o parâmetro com 5xx',
    ],
  ]);
});

it('normalizes legacy string repositories and drops duplicates before selection', () => {
  // Act / Assert
  expect(
    incidentActionRepositories({
      repositories: [
        'service-15',
        'service-15',
        { name: 'service-15', role: 'origem' },
        {},
        7,
      ],
    }),
  ).toStrictEqual([{ name: 'service-15' }]);
});

for (const names of [['mail'], ['../service-15']]) {
  it(`rejects ambiguous or unavailable repositories: ${names}`, () => {
    // Arrange
    const context = { repositories: [{ name: 'service-15' }] };
    // Act
    const selected = selectIncidentRepositories(
      { repositories: names, confidence: 'high' },
      context,
    );
    // Assert
    expect(selected).toStrictEqual([]);
  });
}

it('keeps the repositories that exist when the model also names one that is unavailable', () => {
  // Arrange
  const context = { repositories: [{ name: 'service-15' }] };
  // Act
  const selected = selectIncidentRepositories(
    { repositories: ['service-15', 'invented'], confidence: 'high' },
    context,
  );
  // Assert
  expect(selected).toStrictEqual([
    { name: 'service-15', role: null, scope: null },
  ]);
});

it('insufficient confidence cannot select an automatic issue target', () => {
  // Arrange
  const context = { repositories: [{ name: 'service-15' }] };
  // Act
  const selected = selectIncidentRepositories(
    { repositories: ['service-15'], confidence: 'medium' },
    context,
  );
  // Assert
  expect(selected).toStrictEqual([]);
});

it('derives the GitHub slug from supported remotes without accepting lookalike hosts', () => {
  // Arrange
  const remotes = [
    'git@github.com:org/repo.git',
    'https://github.com/org/repo.git',
    'ssh://git@github.com/org/repo',
  ];
  // Act / Assert
  for (const remote of remotes) expect(githubSlug(remote)).toBe('org/repo');
  expect(githubSlug('https://evilgithub.com/org/repo')).toBe(null);
});
