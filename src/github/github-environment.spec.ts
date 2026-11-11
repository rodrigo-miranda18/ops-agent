import { describe, expect, it } from 'vitest';
import { githubProcessEnvironment } from './github-environment.js';

describe('githubProcessEnvironment', () => {
  it('keeps required system and network values without unrelated secrets', () => {
    const environment = githubProcessEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/app',
        LANG: 'pt_BR.UTF-8',
        SSL_CERT_FILE: '/certs/ca.pem',
        HTTPS_PROXY: 'http://proxy.internal',
        NO_PROXY: 'github.com',
        GH_TOKEN: 'stale-token',
        CLICKUP_API_TOKEN: 'clickup-secret',
        SALES_POSTGRESQL_PASSWORD: 'database-secret',
      },
      'current-token',
    );

    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/app',
      LANG: 'pt_BR.UTF-8',
      SSL_CERT_FILE: '/certs/ca.pem',
      HTTPS_PROXY: 'http://proxy.internal',
      NO_PROXY: 'github.com',
      GH_TOKEN: 'current-token',
      GH_PROMPT_DISABLED: 'true',
    });
  });
});
