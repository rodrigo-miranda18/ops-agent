#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../common/sanitize.js';
import {
  githubConfigFromEnv,
  type GitHubConfig,
} from '../config/github-config.js';
import {
  createGitHubCredentialProvider,
  type GitHubCredentialProvider,
} from './github-credentials.js';

export interface GitCredentialRequest {
  protocol?: string;
  host?: string;
  path?: string;
  username?: string;
}

export function parseGitCredentialInput(input: string): GitCredentialRequest {
  const request: GitCredentialRequest = {};
  for (const line of input.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      key === 'protocol' ||
      key === 'host' ||
      key === 'path' ||
      key === 'username'
    )
      request[key] = value;
  }
  return request;
}

export async function gitCredentialResponse(
  operation: string,
  input: string,
  config: GitHubConfig,
  credentials: GitHubCredentialProvider,
): Promise<string> {
  void config;
  if (operation !== 'get') return '';
  const request = parseGitCredentialInput(input);
  if (request.protocol !== 'https' || request.host !== 'github.com') return '';
  try {
    const credential = await credentials.getCredential();
    return `username=x-access-token\npassword=${credential.token}\n\n`;
  } catch {
    throw new Error('GitHub credential helper could not obtain a credential');
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function runGitCredentialHelper(
  operation: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  try {
    const config = githubConfigFromEnv(env);
    const credentials = createGitHubCredentialProvider(config);
    const response = await gitCredentialResponse(
      operation || '',
      await readStdin(),
      config,
      credentials,
    );
    if (response) process.stdout.write(response);
    return 0;
  } catch (error) {
    process.stderr.write(
      `GitHub credential helper failed: ${sanitize((error as Error).message)}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runGitCredentialHelper(process.argv[2], process.env);
}
