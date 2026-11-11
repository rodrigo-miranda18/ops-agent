import { describe, expect, it } from 'vitest';
import type { IssueStatus } from '../github/github.types.js';
import {
  isStaleIssue,
  issueUrlsFromIncidentIssues,
  staleIssueComment,
} from './stale-issues.js';

const now = new Date('2026-09-28T12:00:00.000Z');
const issue = (overrides: Partial<IssueStatus> = {}): IssueStatus => ({
  url: 'https://github.com/org/repo/issues/1',
  state: 'OPEN',
  updatedAt: '2026-08-29T12:00:00Z',
  assignees: [],
  commentBodies: [],
  ...overrides,
});

describe('isStaleIssue', () => {
  it('treats an open unassigned issue idle for exactly the max age as stale', () => {
    expect(isStaleIssue(issue(), now, 30)).toBe(true);
  });

  it('keeps an issue with activity inside the window', () => {
    expect(
      isStaleIssue(issue({ updatedAt: '2026-08-29T12:00:01Z' }), now, 30),
    ).toBe(false);
  });

  it('keeps an assigned issue', () => {
    expect(isStaleIssue(issue({ assignees: ['ana'] }), now, 30)).toBe(false);
  });

  it('ignores closed issues', () => {
    expect(isStaleIssue(issue({ state: 'CLOSED' }), now, 30)).toBe(false);
  });
});

describe('issueUrlsFromIncidentIssues', () => {
  it('returns the issue urls recorded for a ticket', () => {
    expect(
      issueUrlsFromIncidentIssues([
        { repository: 'a', url: 'https://github.com/org/a/issues/1' },
        { repository: 'b', reused: true },
        { url: ' ' },
        null,
      ]),
    ).toEqual(['https://github.com/org/a/issues/1']);
  });

  it.each([null, {}, 'text'])('returns nothing for %j', (value) => {
    expect(issueUrlsFromIncidentIssues(value)).toEqual([]);
  });
});

describe('staleIssueComment', () => {
  it('mentions the window and that a recurrence opens a new issue', () => {
    expect(staleIssueComment(30)).toContain('30 dias');
    expect(staleIssueComment(30)).toContain('nova issue');
  });
});
