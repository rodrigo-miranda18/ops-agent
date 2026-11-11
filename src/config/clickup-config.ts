import { type Environment } from './env.js';

export const CLICKUP_CONFIG = Symbol('CLICKUP_CONFIG');

export type ClickUpConfig = ReturnType<typeof clickUpConfig>;

export function clickUpConfig(env: Environment = process.env) {
  return {
    token: env.CLICKUP_API_TOKEN,
    inDevelopmentStatus:
      env.CLICKUP_IN_DEVELOPMENT_STATUS || '7. em desenvolvimento',
  };
}
