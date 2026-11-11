import {
  CERTIFICATE_ENVIRONMENT,
  pickEnv,
  PROXY_ENVIRONMENT,
  SYSTEM_ENVIRONMENT,
  type Environment,
} from '../config/env.js';

export function githubProcessEnvironment(
  baseEnv: Environment,
  token: string,
): Record<string, string> {
  return {
    ...pickEnv(
      [...SYSTEM_ENVIRONMENT, ...CERTIFICATE_ENVIRONMENT, ...PROXY_ENVIRONMENT],
      baseEnv,
    ),
    GH_TOKEN: token,
    GH_PROMPT_DISABLED: 'true',
  };
}
