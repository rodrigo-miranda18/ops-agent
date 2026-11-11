import { describe, expect, it } from 'vitest';
import { isActiveRunStatus, RUN_STATUSES } from './diagnosis-run.js';

describe('diagnosis run statuses', () => {
  it('treats interrupted as terminal', () => {
    expect(RUN_STATUSES).toContain('interrupted');
    expect(isActiveRunStatus('interrupted')).toBe(false);
  });
});
