import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { hasBearerToken } from '../common/safe-equal.js';
import { AUTH_CONFIG, type AuthConfig } from '../config/auth-config.js';

@Injectable()
export class GrafanaWebhookGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly auth: AuthConfig) {}

  canActivate(context: ExecutionContext) {
    const expected = this.auth.grafanaWebhookToken;
    const request = context.switchToHttp().getRequest<Request>();
    if (!expected || !hasBearerToken(request.headers.authorization, expected))
      throw new UnauthorizedException('Invalid Grafana webhook token');
    return true;
  }
}
