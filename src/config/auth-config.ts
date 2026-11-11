import { type Environment } from './env.js';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

export interface AuthConfig {
  diagnosisApiKey: string | undefined;
  grafanaWebhookToken: string | undefined;
}

export function authConfig(env: Environment = process.env): AuthConfig {
  return {
    diagnosisApiKey: env.DIAGNOSIS_API_KEY,
    grafanaWebhookToken: env.GRAFANA_WEBHOOK_TOKEN,
  };
}
