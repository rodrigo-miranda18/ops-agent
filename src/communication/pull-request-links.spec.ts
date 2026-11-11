import { describe, expect, it } from 'vitest';
import {
  extractPullRequestLinks,
  isOrganizationPullRequest,
  sanitizePullRequestView,
} from './pull-request-links.js';

describe('extractPullRequestLinks', () => {
  it('extracts and deduplicates pull request links from ClickUp texts', () => {
    expect(
      extractPullRequestLinks([
        'PR: github.com/Example-org/service-17/pull/812',
        'https://github.com/Example-org/service-17/pull/812#issuecomment-123',
        '(https://github.com/Example-org/service-04/pull/45).',
        'github.com/Example-org/service-17/pulls',
      ]),
    ).toEqual([
      {
        owner: 'Example-org',
        repo: 'service-17',
        number: 812,
        url: 'https://github.com/Example-org/service-17/pull/812',
      },
      {
        owner: 'Example-org',
        repo: 'service-04',
        number: 45,
        url: 'https://github.com/Example-org/service-04/pull/45',
      },
    ]);
  });
});

describe('isOrganizationPullRequest', () => {
  it('matches the organization case-insensitively', () => {
    const ref = { owner: 'example-ORG', repo: 'r', number: 1, url: 'u' };
    expect(isOrganizationPullRequest(ref, 'Example-org')).toBe(true);
    expect(
      isOrganizationPullRequest({ ...ref, owner: 'other' }, 'Example-org'),
    ).toBe(false);
  });
});

describe('sanitizePullRequestView', () => {
  it('redacts secrets from the title and body', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    expect(
      sanitizePullRequestView({
        title: `fix ${token}`,
        body: `password=hunter2\nAuthorization: Bearer ${token}`,
        state: 'MERGED',
        files: [{ path: 'a.ts' }],
      }),
    ).toEqual({
      title: 'fix [REDACTED_GITHUB_TOKEN]',
      body: 'password=[REDACTED]\nAuthorization: [REDACTED]',
      state: 'MERGED',
      files: [{ path: 'a.ts' }],
    });
  });
});
