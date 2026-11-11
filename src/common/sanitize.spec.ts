import { describe, expect, it } from 'vitest';
import { sanitize } from './sanitize.js';

describe('sanitize', () => {
  it('mascara token do ClickUp, credenciais em URL e header Authorization', () => {
    expect(
      sanitize(
        'token pk_123_AB-c clone https://user:secret@github.com/x Authorization: abc',
      ),
    ).toBe(
      'token [REDACTED_CLICKUP_TOKEN] clone https://[REDACTED_CREDENTIALS]@github.com/x Authorization: [REDACTED]',
    );
  });

  it.each([
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11AA_long_token_value',
    'ghs_installation_token_value',
    'Authorization: Bearer secret-value',
    'Authorization: token secret-value',
    'https://x-access-token:secret-value@github.com/Driva/repo.git',
  ])('redacts GitHub credential form %s', (value) => {
    expect(sanitize(value)).not.toContain('secret-value');
    expect(sanitize(value)).not.toContain(value);
  });

  it('redacts a credential-helper password while retaining its username', () => {
    expect(sanitize('password=secret-value\nusername=x-access-token')).toBe(
      'password=[REDACTED]\nusername=x-access-token',
    );
  });

  it('does not redact arbitrary token words outside credential contexts', () => {
    expect(sanitize('token renewal failed')).toBe('token renewal failed');
  });

  it('converte valores vazios e não textuais', () => {
    expect(sanitize(null)).toBe('');
    expect(sanitize(undefined)).toBe('');
    expect(sanitize('SIGTERM')).toBe('SIGTERM');
  });
});
