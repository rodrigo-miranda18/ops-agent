import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { authConfig } from '../config/auth-config.js';
import { GrafanaWebhookGuard } from './grafana-webhook.guard.js';

function httpContext(authorization?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('GrafanaWebhookGuard', () => {
  const guard = new GrafanaWebhookGuard(
    authConfig({ GRAFANA_WEBHOOK_TOKEN: 'token' }),
  );

  it('accepts the configured bearer token', () => {
    expect(guard.canActivate(httpContext('Bearer token'))).toBe(true);
  });

  it('rejects an invalid token', () => {
    expect(() => guard.canActivate(httpContext('Bearer incorrect'))).toThrow(
      'Invalid Grafana webhook token',
    );
  });

  it('rejects a missing token', () => {
    expect(() => guard.canActivate(httpContext())).toThrow(
      'Invalid Grafana webhook token',
    );
  });

  it('rejects every request when the token is not configured', () => {
    const unconfigured = new GrafanaWebhookGuard(authConfig({}));
    expect(() => unconfigured.canActivate(httpContext('Bearer '))).toThrow(
      'Invalid Grafana webhook token',
    );
  });
});
