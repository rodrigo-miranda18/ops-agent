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
export class DiagnosisApiKeyGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly auth: AuthConfig) {}

  canActivate(context: ExecutionContext) {
    const expected = this.auth.diagnosisApiKey;
    if (!expected)
      throw new UnauthorizedException('DIAGNOSIS_API_KEY is not configured');
    const request = context.switchToHttp().getRequest<Request>();
    if (!hasBearerToken(request.headers.authorization, expected))
      throw new UnauthorizedException('Invalid bearer token');
    return true;
  }
}
