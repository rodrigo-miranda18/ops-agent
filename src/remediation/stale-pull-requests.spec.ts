import { describe, expect, it } from 'vitest';
import {
  isStalePullRequest,
  pullRequestUrlsFromRemediation,
} from './stale-pull-requests.js';

const now = new Date('2026-09-28T12:00:00.000Z');
const pr = (state: string, updatedAt: string) => ({
  url: 'https://github.com/org/repo/pull/1',
  state,
  updatedAt,
});

describe('isStalePullRequest', () => {
  it('treats an open PR idle for exactly the max age as stale', () => {
    expect(
      isStalePullRequest(pr('OPEN', '2026-09-14T12:00:00Z'), now, 14),
    ).toBe(true);
  });

  it('keeps an open PR with activity inside the window', () => {
    expect(
      isStalePullRequest(pr('OPEN', '2026-09-14T12:00:01Z'), now, 14),
    ).toBe(false);
  });

  it.each(['CLOSED', 'MERGED'])('ignores %s PRs', (state) => {
    expect(isStalePullRequest(pr(state, '2026-01-01T00:00:00Z'), now, 14)).toBe(
      false,
    );
  });

  it('ignores an invalid updatedAt', () => {
    expect(isStalePullRequest(pr('OPEN', 'not a date'), now, 14)).toBe(false);
  });
});

describe('pullRequestUrlsFromRemediation', () => {
  it('returns the PR urls recorded in a remediation result', () => {
    expect(
      pullRequestUrlsFromRemediation({
        pull_requests: [
          { repository: 'a', url: 'https://github.com/org/a/pull/1' },
          { repository: 'b' },
          { url: '  ' },
          { url: 42 },
          null,
        ],
      }),
    ).toEqual(['https://github.com/org/a/pull/1']);
  });

  it.each([null, 'text', [], {}, { pull_requests: 'x' }])(
    'returns nothing for %j',
    (value) => {
      expect(pullRequestUrlsFromRemediation(value)).toEqual([]);
    },
  );
});
