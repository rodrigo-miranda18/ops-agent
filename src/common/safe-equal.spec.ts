import { describe, expect, it } from 'vitest';
import { hasBearerToken, safeEqual } from './safe-equal.js';

describe('safeEqual', () => {
  it('compares strings of any length', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secre', 'secret')).toBe(false);
    expect(safeEqual(undefined, 'secret')).toBe(false);
  });

  it('requires the exact bearer header', () => {
    expect(hasBearerToken('Bearer key', 'key')).toBe(true);
    expect(hasBearerToken('bearer key', 'key')).toBe(false);
    expect(hasBearerToken('key', 'key')).toBe(false);
  });
});
