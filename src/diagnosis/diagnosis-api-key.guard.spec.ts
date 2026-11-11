import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { authConfig } from '../config/auth-config.js';
import { DiagnosisApiKeyGuard } from './diagnosis-api-key.guard.js';

function httpContext(authorization?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('DiagnosisApiKeyGuard', () => {
  const guard = new DiagnosisApiKeyGuard(
    authConfig({ DIAGNOSIS_API_KEY: 'key' }),
  );

  it('accepts the configured bearer token', () => {
    expect(guard.canActivate(httpContext('Bearer key'))).toBe(true);
  });

  it('rejects an invalid token', () => {
    expect(() => guard.canActivate(httpContext('Bearer nope'))).toThrow(
      'Invalid bearer token',
    );
  });

  it('rejects a missing token', () => {
    expect(() => guard.canActivate(httpContext())).toThrow(
      'Invalid bearer token',
    );
  });

  it('rejects every request when the key is not configured', () => {
    const unconfigured = new DiagnosisApiKeyGuard(authConfig({}));
    expect(() => unconfigured.canActivate(httpContext('Bearer '))).toThrow(
      'DIAGNOSIS_API_KEY is not configured',
    );
  });
});
