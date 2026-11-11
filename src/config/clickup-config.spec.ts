import { describe, expect, it } from 'vitest';
import { clickUpConfig } from './clickup-config.js';

describe('clickUpConfig', () => {
  it('applies defaults when nothing is set', () => {
    expect(clickUpConfig({})).toEqual({
      token: undefined,
      inDevelopmentStatus: '7. em desenvolvimento',
    });
  });

  it('reads overrides from the environment', () => {
    expect(
      clickUpConfig({
        CLICKUP_API_TOKEN: 'token',
        CLICKUP_IN_DEVELOPMENT_STATUS: 'doing',
      }),
    ).toEqual({
      token: 'token',
      inDevelopmentStatus: 'doing',
    });
  });
});
