# GitHub App Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production personal `GH_TOKEN` with renewable GitHub App installation credentials while preserving repository sync, autonomous Codex remediation, pull-request and incident-issue behavior.

**Architecture:** Add a discriminated GitHub auth configuration and a framework-independent credential provider that supports static and GitHub App modes. Controlled GitHub calls obtain a current token per subprocess; Codex uses a `gh` wrapper and Git credential helper that mint credentials at execution time, allowing remediations to outlive a one-hour installation token.

**Tech Stack:** Node.js 24, TypeScript strict/NodeNext, NestJS 11, Vitest, built-in `node:crypto`, built-in `fetch`, Git credential protocol, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-10-03-github-app-auth-design.md`

## Global Constraints

- Keep the Nest HTTP process and runner child process separate.
- Read `process.env` only inside `src/config/` and CLI entrypoints.
- Keep all production source in `.ts`; do not add shell scripts outside the existing `docker/entrypoint.sh` exception.
- Use relative NodeNext imports with `.js` extensions.
- Treat GitHub API, wrapper stdin, and credential-helper stdin as `unknown` until validated.
- Do not pass the full process environment to GitHub subprocesses.
- Do not expose the private key, JWT, installation token, authenticated URL, or authorization header in logs or artifacts.
- Preserve `GITHUB_DDS_TOKEN` and GitHub Packages behavior unchanged.
- Preserve existing notification, ClickUp, issue reuse, PR reuse, supersession, reorientation, and stale-cleanup behavior.
- Do not add merge, deployment, workflow-write, administration, environment, or ruleset-bypass capability.
- Keep `GITHUB_AUTH_MODE=static` as a rollback and local-development path.
- All external integrations remain mocked in tests.
- Every task follows red-green-refactor and ends with a focused commit.

## Review Focus

- App mode with an unreadable or malformed PEM must fail clearly before a remediation starts, without printing key material.
- Concurrent token requests around the refresh boundary must produce one GitHub token request, not a refresh stampede.
- A remediation that invokes `gh` or `git push` after the previous token expires must obtain a new token without restarting Codex.
- A GitHub 403 caused by permissions or rate limiting must not be misclassified as token expiration and retried blindly.
- Credential-helper and wrapper failures must not write credentials into stderr, remediation artifacts, or health output.

---

## Planned File Structure

### New files

- `src/config/github-config.ts` — discriminated static/App configuration and validation.
- `src/config/github-config.spec.ts` — configuration contract tests.
- `src/github/github-credentials.ts` — provider interface, static provider, App provider, cache, refresh coalescing, and factory.
- `src/github/github-credentials.spec.ts` — JWT, API validation, cache, refresh, and redaction tests.
- `src/github/github-api.types.ts` — validated external response types for installation and token endpoints.
- `src/github/github-environment.ts` — allowlisted environment construction shared by adapters and helpers.
- `src/github/github-environment.spec.ts` — environment filtering tests.
- `src/github/gh-wrapper.ts` — executable wrapper used as `gh` inside Codex remediation.
- `src/github/gh-wrapper.spec.ts` — wrapper process forwarding and token refresh tests.
- `src/github/git-credential-app.ts` — executable Git credential helper.
- `src/github/git-credential-app.spec.ts` — Git credential protocol tests.
- `src/runner/runner-dependencies.ts` — process-scoped GitHub executor and remediation preflight dependencies.
- `src/runner/runner-dependencies.spec.ts` — runner dependency construction tests.
- `src/runner/runner-codex.spec.ts` — remediation environment and diagnosis isolation tests.
- `src/diagnosis/ticket-processing.spec.ts` — dependency propagation and per-ticket containment tests.
- `src/remediation/remediation-run.spec.ts` — preflight and existing remediation behavior tests.

### Existing files with focused modifications

- `src/config/config.module.ts` — export `GITHUB_CONFIG`.
- `src/config/app-config.ts` — make configuration summary mode-aware.
- `src/config/app-config.spec.ts` — summary regression tests.
- `src/config/runner-config.ts` — include typed GitHub configuration in runner config.
- `src/config/runner-config.spec.ts` — runner GitHub config tests.
- `src/config/env.ts` — define GitHub helper allowlist and remove fixed App-mode token injection.
- `src/config/env.spec.ts` — Codex environment tests.
- `src/github/gh.ts` — credential-aware `gh` executor with allowlisted env and one expiration retry.
- `src/github/gh.spec.ts` — adapter authentication and retry tests.
- `src/github/github.module.ts` — provide credential provider to Nest consumers.
- `src/github/github.service.ts` — constructor injection of the authenticated executor.
- `src/github/github.service.spec.ts` — service wiring regression tests.
- `src/git/git.ts` — allowlisted Git/helper environment instead of all `process.env`.
- `src/git/git.spec.ts` — helper environment and secret-isolation tests.
- `src/runner.ts` — create runner dependencies once and pass them through processing flows.
- `src/runner/runner-codex.ts` — prepend wrapper directory and pass App helper configuration only for remediation.
- `src/diagnosis/ticket-processing.ts` — accept runner dependencies.
- `src/remediation/ticket-remediation.ts` — pass GitHub executor and preflight into remediation.
- `src/remediation/remediation-run.ts` — use injected executor and call preflight before automatic remediation.
- `src/remediation/remediation-reorientation-run.ts` — reuse the same runner dependencies.
- `src/remediation/remediation-reorientation.spec.ts` — dependency propagation tests.
- `src/incidents/incident-processing.ts` — use injected runner dependencies.
- `src/incidents/incident-issues.ts` — standardize on the args-only GitHub executor.
- `src/incidents/runner-integration.spec.ts` — incident GitHub regression tests.
- `src/common/sanitize.ts` — redact GitHub credentials and authorization forms.
- `src/common/sanitize.spec.ts` — redaction tests.
- `src/health/health.module.ts` — import `GithubModule`.
- `src/health/health.service.ts` — App-aware credential and repository health.
- `src/health/health.service.spec.ts` — static/App health tests.
- `docker/entrypoint.sh` — configure HTTPS rewrites and credential helper by auth mode.
- `Dockerfile` — install compiled wrapper path and ensure executable permissions.
- `.env.example` — document App and static configuration.
- `README.md` — document authentication modes and App permissions.
- `docs/DEPLOY_HANDOFF.md` — document Dokku secret mount, cutover, verification, and rollback.

---

### Task 1: Add typed GitHub authentication configuration

**Files:**

- Create: `src/config/github-config.ts`
- Create: `src/config/github-config.spec.ts`
- Modify: `src/config/config.module.ts:1-25`
- Modify: `src/config/app-config.ts:101-110`
- Modify: `src/config/app-config.spec.ts`
- Modify: `src/config/runner-config.ts:36-119`
- Modify: `src/config/runner-config.spec.ts`

**Interfaces:**

- Produces:

```typescript
export const GITHUB_AUTH_MODES = ['static', 'app'] as const;
export type GitHubAuthMode = (typeof GITHUB_AUTH_MODES)[number];

export interface StaticGitHubConfig {
  mode: 'static';
  token: string;
}

export interface AppGitHubConfig {
  mode: 'app';
  appId: string;
  clientId: string;
  organization: string;
  healthRepository: string;
  privateKeyFile: string;
  installationId?: number;
  tokenRefreshSkewMs: number;
}

export type GitHubConfig = StaticGitHubConfig | AppGitHubConfig;
export const GITHUB_CONFIG = Symbol('GITHUB_CONFIG');
export function githubConfigFromEnv(env?: Environment): GitHubConfig;
```

- Later tasks consume `GitHubConfig` without reading `process.env`.

- [ ] **Step 1: Write failing configuration tests**

Cover these exact cases in `src/config/github-config.spec.ts`:

```typescript
it('parses static mode with GH_TOKEN', () => {
  expect(
    githubConfigFromEnv({ GITHUB_AUTH_MODE: 'static', GH_TOKEN: 'token' }),
  ).toEqual({ mode: 'static', token: 'token' });
});

it('parses app mode and converts refresh skew to milliseconds', () => {
  expect(
    githubConfigFromEnv({
      GITHUB_AUTH_MODE: 'app',
      GITHUB_APP_ID: '123',
      GITHUB_APP_CLIENT_ID: 'Iv1.client',
      GITHUB_APP_ORGANIZATION: 'Example-org',
      GITHUB_APP_HEALTH_REPOSITORY: 'service-15',
      GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
      GITHUB_APP_INSTALLATION_ID: '456',
      GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS: '300',
    }),
  ).toEqual({
    mode: 'app',
    appId: '123',
    clientId: 'Iv1.client',
    organization: 'Example-org',
    healthRepository: 'service-15',
    privateKeyFile: keyPath,
    installationId: 456,
    tokenRefreshSkewMs: 300_000,
  });
});
```

Also assert explicit errors for an unknown mode, missing static token, missing App fields, non-positive installation ID, refresh skew of zero, refresh skew of 3600 seconds or more, and an unreadable key path. Create the key fixture with mode `0o600` in a temporary directory.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm test -- src/config/github-config.spec.ts
```

Expected: FAIL because `github-config.ts` and its exports do not exist.

- [ ] **Step 3: Implement the discriminated configuration**

Use `accessSync(privateKeyFile, constants.R_OK)` in App mode so boot and standalone runner configuration fail before work starts. Default `GITHUB_AUTH_MODE` to `static` only when `GH_TOKEN` is present; otherwise require the mode explicitly so an empty production configuration does not silently select an unusable path.

Use `clientId` as the JWT issuer in later tasks, while retaining `appId` for identity and operational logs.

- [ ] **Step 4: Register and propagate the config**

Add this provider to `ConfigModule`:

```typescript
{ provide: GITHUB_CONFIG, useFactory: () => githubConfigFromEnv() }
```

Export `GITHUB_CONFIG`. Add `github: githubConfigFromEnv(env)` to `runnerConfigFromEnv`, and update `configurationSummary` so `githubCredential` is true for a valid mode rather than checking only `GH_TOKEN`.

- [ ] **Step 5: Run configuration suites**

Run:

```bash
npm test -- src/config/github-config.spec.ts src/config/app-config.spec.ts src/config/runner-config.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/github-config.ts src/config/github-config.spec.ts src/config/config.module.ts src/config/app-config.ts src/config/app-config.spec.ts src/config/runner-config.ts src/config/runner-config.spec.ts
git commit -m "feat: add GitHub authentication configuration"
```

---

### Task 2: Implement renewable GitHub App credentials

**Files:**

- Create: `src/github/github-api.types.ts`
- Create: `src/github/github-credentials.ts`
- Create: `src/github/github-credentials.spec.ts`

**Interfaces:**

- Consumes: `GitHubConfig` from Task 1.
- Produces:

```typescript
export interface GitHubCredential {
  token: string;
  expiresAt: Date | null;
  installationId: number | null;
}

export interface GitHubCredentialProvider {
  getCredential(): Promise<GitHubCredential>;
  invalidate(): void;
}

export interface GitHubCredentialDependencies {
  fetch: typeof fetch;
  now: () => Date;
  readPrivateKey: (filename: string) => Promise<string>;
}

export function createGitHubCredentialProvider(
  config: GitHubConfig,
  dependencies?: Partial<GitHubCredentialDependencies>,
): GitHubCredentialProvider;
```

- [ ] **Step 1: Write failing JWT and external-response tests**

Test with an ephemeral RSA key pair generated by `generateKeyPairSync('rsa', { modulusLength: 2048 })`. Decode the JWT header and payload and assert:

```typescript
expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
expect(payload.iss).toBe('Iv1.client');
expect(payload.iat).toBe(nowEpochSeconds - 60);
expect(payload.exp).toBe(nowEpochSeconds + 540);
```

Verify the signature with the generated public key. Add failures for installation responses without numeric `id` and token responses without non-empty `token` or valid `expires_at`.

- [ ] **Step 2: Run the provider tests and verify failure**

```bash
npm test -- src/github/github-credentials.spec.ts
```

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement static credentials and JWT signing**

Static mode returns:

```typescript
{ token: config.token, expiresAt: null, installationId: null }
```

App mode reads the key lazily once, creates an RS256 JWT with `iat` 60 seconds in the past and `exp` nine minutes in the future, and sends these headers:

```typescript
{
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${jwt}`,
  'X-GitHub-Api-Version': '2026-03-10',
}
```

Resolve the installation with `GET https://api.github.com/orgs/{organization}/installation` unless `installationId` is configured.

- [ ] **Step 4: Write failing cache and concurrency tests**

Use a deferred fetch promise and call `getCredential()` three times concurrently. Assert only one access-token request occurs. Advance the injected clock to one millisecond before and at `expiresAt - tokenRefreshSkewMs`; assert cache hit before the boundary and refresh at the boundary.

Add the Review Focus test: malformed PEM rejects with a sanitized message containing the filename but not PEM content.

- [ ] **Step 5: Implement token exchange, cache, and refresh coalescing**

POST to:

```text
https://api.github.com/app/installations/{installationId}/access_tokens
```

Keep `cachedCredential` and `refreshPromise` inside the provider instance. Clear `refreshPromise` in `finally`. `invalidate()` clears only the installation token cache, not the resolved installation ID or loaded private key.

- [ ] **Step 6: Run provider tests**

```bash
npm test -- src/github/github-credentials.spec.ts
```

Expected: PASS, including one request for concurrent refreshes.

- [ ] **Step 7: Commit**

```bash
git add src/github/github-api.types.ts src/github/github-credentials.ts src/github/github-credentials.spec.ts
git commit -m "feat: generate renewable GitHub App credentials"
```

---

### Task 3: Extend credential sanitization

**Files:**

- Modify: `src/common/sanitize.ts:1-6`
- Modify: `src/common/sanitize.spec.ts`

**Interfaces:**

- Produces: existing `sanitize(value: unknown): string` with broader GitHub redaction.

- [ ] **Step 1: Add failing redaction cases**

Assert redaction for:

```typescript
const values = [
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'github_pat_11AA_long_token_value',
  'ghs_installation_token_value',
  'Authorization: Bearer secret-value',
  'Authorization: token secret-value',
  'https://x-access-token:secret-value@github.com/Driva/repo.git',
  'password=secret-value\nusername=x-access-token',
];
```

The credential-helper protocol test must sanitize the password line while retaining the username line.

- [ ] **Step 2: Verify failure**

```bash
npm test -- src/common/sanitize.spec.ts
```

Expected: FAIL because GitHub token forms remain visible.

- [ ] **Step 3: Implement narrowly scoped patterns**

Preserve existing ClickUp and URL redaction. Add GitHub token-prefix patterns, case-insensitive generic authorization-header redaction through the end of the line, authenticated GitHub URL redaction, and `password=` line redaction. Do not redact arbitrary words named `token` outside credential contexts.

- [ ] **Step 4: Run tests**

```bash
npm test -- src/common/sanitize.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/sanitize.ts src/common/sanitize.spec.ts
git commit -m "fix: redact GitHub App credentials"
```

---

### Task 4: Build the authenticated `gh` executor and Nest wiring

**Files:**

- Create: `src/github/github-environment.ts`
- Create: `src/github/github-environment.spec.ts`
- Modify: `src/github/gh.ts:1-56`
- Modify: `src/github/gh.spec.ts`
- Modify: `src/github/github.module.ts:1-8`
- Modify: `src/github/github.service.ts:1-16`
- Modify: `src/github/github.service.spec.ts`

**Interfaces:**

- Consumes: `GitHubCredentialProvider` from Task 2.
- Produces:

```typescript
export type GitHubExecutor = (args: readonly string[]) => Promise<string>;

export interface GitHubExecutorOptions {
  credentials: GitHubCredentialProvider;
  cwd?: string;
  timeoutMs: number;
  baseEnv: Environment;
  command?: string;
  formatError?: GhOptions['formatError'];
}

export function githubProcessEnvironment(
  baseEnv: Environment,
  token: string,
): Record<string, string>;

export function createGitHubExecutor(
  options: GitHubExecutorOptions,
): GitHubExecutor;
```

- [ ] **Step 1: Write failing environment-allowlist tests**

Given an environment containing `PATH`, `HOME`, certificate/proxy variables, `CLICKUP_API_TOKEN`, database passwords, and `GH_TOKEN`, assert the result contains required system/network values and the newly supplied `GH_TOKEN`, but excludes ClickUp and database credentials.

- [ ] **Step 2: Write failing executor tests**

Mock `runProcess` and a credential provider. Assert each call obtains a credential immediately before spawning `gh`, sets `GH_PROMPT_DISABLED=true`, and uses the allowlisted environment.

Add two retry cases:

- exit 1 with stderr containing an explicit GitHub authentication-expired/Bad credentials response: invalidate and retry exactly once;
- exit 1 with a 403 rate-limit or resource-not-accessible message: do not invalidate or retry.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
npm test -- src/github/github-environment.spec.ts src/github/gh.spec.ts
```

Expected: FAIL on missing constructors and environment builder.

- [ ] **Step 4: Implement executor and retry classification**

Keep error formatting behavior from `runnerGhError` and `serviceGhError`. Retry only when stderr/stdout contains a tested authentication-expiration signature such as `Bad credentials` or HTTP 401; never retry all 403 responses.

- [ ] **Step 5: Wire Nest through `GithubModule`**

Provide `GITHUB_CREDENTIAL_PROVIDER` using `GITHUB_CONFIG`, then inject it into `GithubService`. Construct the service executor once:

```typescript
constructor(
  @Inject(GITHUB_CREDENTIAL_PROVIDER)
  credentials: GitHubCredentialProvider,
  @Inject(RUNTIME_CONFIG) runtime: RuntimeConfig,
) {
  this.execute = createGitHubExecutor({
    credentials,
    timeoutMs: 60_000,
    baseEnv: runtime.processEnv,
    formatError: serviceGhError,
  });
}
```

Retain assignment of `execute` in tests only if existing tests rely on replacing it; prefer constructor injection of a fake executor where practical.

- [ ] **Step 6: Run GitHub module tests**

```bash
npm test -- src/github/github-environment.spec.ts src/github/gh.spec.ts src/github/github.service.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/github/github-environment.ts src/github/github-environment.spec.ts src/github/gh.ts src/github/gh.spec.ts src/github/github.module.ts src/github/github.service.ts src/github/github.service.spec.ts
git commit -m "feat: authenticate GitHub CLI through credential provider"
```

---

### Task 5: Inject one GitHub executor through runner flows

**Files:**

- Create: `src/runner/runner-dependencies.ts`
- Create: `src/runner/runner-dependencies.spec.ts`
- Modify: `src/runner.ts:72-204`
- Modify: `src/diagnosis/ticket-processing.ts:110-145`
- Create: `src/diagnosis/ticket-processing.spec.ts`
- Modify: `src/remediation/ticket-remediation.ts`
- Modify: `src/remediation/remediation-run.ts:51-255`
- Create: `src/remediation/remediation-run.spec.ts`
- Modify: `src/remediation/remediation-reorientation-run.ts:50-119`
- Modify: `src/remediation/remediation-reorientation.spec.ts`
- Modify: `src/incidents/incident-processing.ts:45-78`
- Modify: `src/incidents/incident-issues.ts:98-420`
- Modify: `src/incidents/runner-integration.spec.ts`

**Interfaces:**

- Consumes: `RunnerConfig['github']`, `createGitHubCredentialProvider`, and `createGitHubExecutor`.
- Produces:

```typescript
export interface RunnerDependencies {
  github: GitHubExecutor;
  ensureGitHubAccess(): Promise<void>;
}

export function createRunnerDependencies(
  config: Pick<RunnerConfig, 'github' | 'reposDir' | 'repositorySyncTimeoutMs'>,
  env?: Environment,
): RunnerDependencies;
```

All runner-domain functions receive `dependencies: RunnerDependencies`; no runner-domain function reads GitHub auth from `process.env` or defaults to a module-global `runnerGh`.

- [ ] **Step 1: Write failing runner-dependency tests**

Assert `createRunnerDependencies` creates one provider and one executor for a runner invocation. `ensureGitHubAccess()` must obtain a current credential and run a read-only installation query through the executor:

```typescript
await github(['api', '/installation/repositories', '--jq', '.total_count']);
```

For static mode, use `gh api user --jq .login` only if installation endpoints reject a static user token; encode this mode distinction in the test rather than relying on a failing production call.

- [ ] **Step 2: Verify failure**

```bash
npm test -- src/runner/runner-dependencies.spec.ts
```

Expected: FAIL because the dependency factory does not exist.

- [ ] **Step 3: Implement runner dependency construction**

Construct the provider once after `runnerConfigFromEnv`. Use `config.reposDir` and `config.repositorySyncTimeoutMs` for the runner executor.

- [ ] **Step 4: Thread dependencies through diagnosis, incident, and reorientation paths**

Change signatures explicitly:

```typescript
processTicket(
  config,
  task,
  comments,
  matchedFields,
  prompt,
  processed,
  args,
  dependencies,
);
processIncident(config, incident, prompt, args, dependencies);
runRemediationReorientation(config, reorientationId, dependencies);
runRemediation(config, ticketDir, ticket, action, mode, context, dependencies);
```

Standardize incident helpers on `GitHubExecutor`, so calls become `github(args)` rather than `github(config, args)`. Remove `runGitHub` and the default `runnerGh` dependency from production paths.

Before `runCodex` in an eligible `mode === 'auto'` remediation, execute:

```typescript
await dependencies.ensureGitHubAccess();
```

If preflight fails, return the existing `IMPLEMENTATION_FAILED` structure with a sanitized reason and do not start Codex.

- [ ] **Step 5: Add regression tests**

Pin these behaviors:

- plan-only remediation does not call preflight;
- auto remediation calls preflight exactly once before Codex;
- failed preflight produces `IMPLEMENTATION_FAILED` and zero Codex calls;
- incident issue creation receives the injected executor;
- reorientation uses the same executor for new remediation and superseded-PR cleanup;
- one ticket's GitHub failure remains contained by existing per-ticket handling.

- [ ] **Step 6: Run runner and domain tests**

```bash
npm test -- src/runner/runner-dependencies.spec.ts src/remediation/remediation-run.spec.ts src/remediation/remediation-reorientation.spec.ts src/incidents/runner-integration.spec.ts src/diagnosis/ticket-processing.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runner/runner-dependencies.ts src/runner/runner-dependencies.spec.ts src/runner.ts src/diagnosis/ticket-processing.ts src/diagnosis/ticket-processing.spec.ts src/remediation/ticket-remediation.ts src/remediation/remediation-run.ts src/remediation/remediation-run.spec.ts src/remediation/remediation-reorientation-run.ts src/remediation/remediation-reorientation.spec.ts src/incidents/incident-processing.ts src/incidents/incident-issues.ts src/incidents/runner-integration.spec.ts
git commit -m "refactor: inject GitHub executor into runner flows"
```

---

### Task 6: Add the renewable `gh` wrapper for Codex remediation

**Files:**

- Create: `src/github/gh-wrapper.ts`
- Create: `src/github/gh-wrapper.spec.ts`
- Modify: `src/config/env.ts:26-81`
- Modify: `src/config/env.spec.ts`
- Modify: `src/runner/runner-codex.ts:13-57`
- Create: `src/runner/runner-codex.spec.ts`
- Modify: `Dockerfile`

**Interfaces:**

- Consumes: `githubConfigFromEnv`, provider factory, and environment builder.
- Produces:

```typescript
export interface GhWrapperDependencies {
  createCredentials(config: GitHubConfig): GitHubCredentialProvider;
  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess;
}

export async function runGhWrapper(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies?: Partial<GhWrapperDependencies>,
): Promise<number>;
```

- [ ] **Step 1: Write failing wrapper tests**

Test that the wrapper:

- loads static and App configuration from the supplied env;
- obtains a credential for every wrapper process;
- executes the real `gh` using `DRIVA_REAL_PATH` rather than the wrapper-prepended `PATH`;
- forwards all arguments unchanged;
- inherits cwd and stdio;
- forwards SIGTERM/SIGINT to the child;
- returns the child's exit code or `1` for spawn/signal failure;
- sanitizes startup errors.

- [ ] **Step 2: Write failing Codex-environment tests**

For diagnosis, assert no `GH_TOKEN`, private-key path, App ID, client ID, or App organization is present.

For remediation, assert:

```typescript
expect(env.PATH).toBe(`/app/github-bin:${originalPath}`);
expect(env.DRIVA_REAL_PATH).toBe(originalPath);
expect(env.GITHUB_AUTH_MODE).toBe('app');
expect(env.GITHUB_APP_PRIVATE_KEY_FILE).toBe('/run/secrets/github.pem');
expect(env.GH_TOKEN).toBeUndefined();
```

For static remediation, assert `GH_TOKEN` is present because the static provider needs it.

- [ ] **Step 3: Verify failure**

```bash
npm test -- src/github/gh-wrapper.spec.ts src/config/env.spec.ts src/runner/runner-codex.spec.ts
```

Expected: FAIL because the wrapper and remediation helper environment do not exist.

- [ ] **Step 4: Implement wrapper and environment allowlist**

Add a `GITHUB_HELPER_ENVIRONMENT` constant containing only:

```typescript
[
  'GITHUB_AUTH_MODE',
  'GH_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_ORGANIZATION',
  'GITHUB_APP_HEALTH_REPOSITORY',
  'GITHUB_APP_PRIVATE_KEY_FILE',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS',
] as const;
```

Include it only for remediation. Keep diagnosis unchanged and credential-free.

The wrapper has a Node shebang, invokes the provider, and spawns the real `gh` with a token-specific allowlisted environment. It must not print its configuration or credential.

- [ ] **Step 5: Add the runtime wrapper path to the image**

In the final image, create `/app/github-bin/gh` as a symlink to `/app/dist/github/gh-wrapper.js` and mark the compiled entrypoint executable. `/usr/local/bin/gh` remains the real binary and is found through `DRIVA_REAL_PATH`.

Confirm the new runtime entrypoint is emitted by `nest build`; it is source TypeScript, so no Nest asset entry is required.

- [ ] **Step 6: Run tests and build**

```bash
npm test -- src/github/gh-wrapper.spec.ts src/config/env.spec.ts src/runner/runner-codex.spec.ts
npm run build
node --check dist/github/gh-wrapper.js
```

Expected: all commands pass.

- [ ] **Step 7: Commit**

```bash
git add src/github/gh-wrapper.ts src/github/gh-wrapper.spec.ts src/config/env.ts src/config/env.spec.ts src/runner/runner-codex.ts src/runner/runner-codex.spec.ts Dockerfile
git commit -m "feat: refresh GitHub credentials inside remediation"
```

---

### Task 7: Add the Git HTTPS credential helper

**Files:**

- Create: `src/github/git-credential-app.ts`
- Create: `src/github/git-credential-app.spec.ts`
- Modify: `src/git/git.ts:1-35`
- Modify: `src/git/git.spec.ts`
- Modify: `docker/entrypoint.sh:4-24`
- Modify: `Dockerfile`

**Interfaces:**

- Consumes: GitHub configuration and credential provider.
- Produces:

```typescript
export interface GitCredentialRequest {
  protocol?: string;
  host?: string;
  path?: string;
  username?: string;
}

export function parseGitCredentialInput(input: string): GitCredentialRequest;
export async function gitCredentialResponse(
  operation: string,
  input: string,
  config: GitHubConfig,
  credentials: GitHubCredentialProvider,
): Promise<string>;
```

- [ ] **Step 1: Write failing protocol tests**

Cover:

```typescript
expect(
  await gitCredentialResponse(
    'get',
    'protocol=https\nhost=github.com\npath=Driva/repo.git\n\n',
    config,
    credentials,
  ),
).toBe('username=x-access-token\npassword=installation-token\n\n');
```

Also assert:

- non-GitHub host returns an empty response;
- non-HTTPS protocol returns an empty response;
- `store` and `erase` return empty responses and never obtain a token;
- malformed lines are ignored without throwing;
- password and PEM content never appear in errors or stderr;
- two separate `get` invocations can return different tokens, proving late renewal.

- [ ] **Step 2: Verify failure**

```bash
npm test -- src/github/git-credential-app.spec.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the credential helper entrypoint**

Use `process.argv[2]` for `get`, `store`, or `erase`; read stdin fully; write only the Git credential response to stdout. Send sanitized fatal messages to stderr and set exit code `1`.

- [ ] **Step 4: Replace broad Git subprocess environment**

Add a Git environment builder based on system, certificate, proxy, Git identity, and GitHub helper configuration. Update `runGit` so ClickUp tokens, database passwords, and unrelated secrets are absent while `GIT_TERMINAL_PROMPT=0` remains present.

The Review Focus test supplies unrelated secrets and asserts the mocked Git spawn cannot see them.

- [ ] **Step 5: Configure Git in the entrypoint**

For both static and App modes:

```bash
git config --global url."https://github.com/".insteadOf "git@github.com:"
git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
git config --global --replace-all credential.https://github.com.helper \
  "!node /app/dist/github/git-credential-app.js"
```

Remove `gh auth setup-git`; the dedicated helper owns GitHub HTTPS authentication. Keep Git author configuration unchanged.

Make `/app/dist/github/git-credential-app.js` executable in the final image.

- [ ] **Step 6: Run helper, Git, and build tests**

```bash
npm test -- src/github/git-credential-app.spec.ts src/git/git.spec.ts
npm run build
node --check dist/github/git-credential-app.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/github/git-credential-app.ts src/github/git-credential-app.spec.ts src/git/git.ts src/git/git.spec.ts docker/entrypoint.sh Dockerfile
git commit -m "feat: authenticate Git HTTPS with GitHub App"
```

---

### Task 8: Make health checks App-aware

**Files:**

- Modify: `src/health/health.module.ts:1-10`
- Modify: `src/health/health.service.ts:1-190`
- Modify: `src/health/health.service.spec.ts`
- Modify: `src/github/github.module.ts`

**Interfaces:**

- Consumes: `GITHUB_CONFIG` and `GITHUB_CREDENTIAL_PROVIDER`.
- Produces health data shaped as:

```typescript
interface GitHubHealthCheck {
  ok: boolean;
  mode: GitHubAuthMode;
  appId?: string;
  installationId?: number;
  expiresAt?: string;
  repositoryAccess?: boolean;
  error?: string;
}
```

No token, JWT, key path contents, or authorization header appears in the response.

- [ ] **Step 1: Replace the old auth-status tests with failing mode-aware tests**

Static mode still verifies the credential through the authenticated executor. App mode asserts:

- provider can mint a credential;
- `installationId` and `expiresAt` are reported;
- `/installation/repositories?per_page=1` succeeds;
- `gh auth status` is not used as the authorization check;
- unreadable/malformed key or failed token exchange degrades health with a sanitized error;
- a rate-limit or permission failure remains distinguishable from missing credentials.

- [ ] **Step 2: Verify failure**

```bash
npm test -- src/health/health.service.spec.ts
```

Expected: FAIL against the current `gh auth status` implementation.

- [ ] **Step 3: Inject GitHub dependencies into HealthService**

Import `GithubModule` from `HealthModule`. Inject the typed config, credential provider, and authenticated executor/service. Keep binary `gh --version` as a dependency check, but replace `commandStatus('gh', ['auth', 'status'])` with the mode-aware credential/repository check.

Do not count GitHub Packages as part of the App check; expose its configuration as an independent boolean in the existing configuration section.

- [ ] **Step 4: Run health tests**

```bash
npm test -- src/health/health.service.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/health/health.module.ts src/health/health.service.ts src/health/health.service.spec.ts src/github/github.module.ts
git commit -m "feat: report GitHub App health"
```

---

### Task 9: Document configuration and operational rollout

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/DEPLOY_HANDOFF.md`

**Interfaces:**

- Documents the exact variables and GitHub-side permissions implemented by Tasks 1–8.

- [ ] **Step 1: Update `.env.example`**

Document static and App modes without real values:

```env
# GitHub authentication: static (rollback/local) or app (production)
GITHUB_AUTH_MODE=app

# Static mode only
GH_TOKEN=

# App mode only
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_ORGANIZATION=Example-org
GITHUB_APP_HEALTH_REPOSITORY=service-15
GITHUB_APP_PRIVATE_KEY_FILE=/app/secrets/github-app-private-key.pem
# Optional: auto-discovered from organization when empty
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS=300
```

Keep `GITHUB_DDS_TOKEN` in its existing separate section and state that it is not replaced by the App migration.

- [ ] **Step 2: Update README behavior and permissions**

Document:

- App mode as the production recommendation;
- installation on selected repositories and private submodules;
- Metadata read, Contents read/write, Pull requests read/write, Issues read/write, Actions read, Checks read;
- no Workflows, Administration, Deployments, Environments, or bypass;
- App bot attribution versus Git commit author identity;
- static rollback mode;
- token renewal through wrapper and credential helper.

- [ ] **Step 3: Update deploy handoff with exact Dokku procedure**

Include commands as operator templates without secret values:

```bash
dokku config:set --no-restart dokku-remote \
  GITHUB_AUTH_MODE=app \
  GITHUB_APP_ID=<app-id> \
  GITHUB_APP_CLIENT_ID=<client-id> \
  GITHUB_APP_ORGANIZATION=Example-org \
  GITHUB_APP_PRIVATE_KEY_FILE=/app/secrets/github-app-private-key.pem
```

Document that the PEM must be mounted read-only rather than materialized with `config:set`. Include selected-repository verification, private-submodule access, process restart, health inspection, sync-only validation, one controlled remediation, bot attribution check, and rollback to static mode.

- [ ] **Step 4: Check documentation formatting and consistency**

```bash
npm run format:check

grep -R "GH_TOKEN" -n README.md docs/DEPLOY_HANDOFF.md .env.example
```

Expected: every remaining `GH_TOKEN` reference is explicitly static-mode, rollback, or historical context; App mode does not instruct operators to persist an installation token.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md docs/DEPLOY_HANDOFF.md
git commit -m "docs: add GitHub App deployment guide"
```

---

### Task 10: Run full verification and a container-level smoke test

**Files:**

- Modify only files required to fix defects exposed by verification.

**Interfaces:**

- Verifies the complete implementation against the spec and existing production contracts.

- [ ] **Step 1: Run focused security and credential suites**

```bash
npm test -- \
  src/config/github-config.spec.ts \
  src/github/github-credentials.spec.ts \
  src/github/github-environment.spec.ts \
  src/github/gh.spec.ts \
  src/github/gh-wrapper.spec.ts \
  src/github/git-credential-app.spec.ts \
  src/common/sanitize.spec.ts \
  src/runner/runner-dependencies.spec.ts \
  src/runner/runner-codex.spec.ts \
  src/health/health.service.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run production-contract regression suites**

```bash
npm test -- \
  src/incidents/runner-integration.spec.ts \
  src/remediation/remediation-run.spec.ts \
  src/remediation/remediation-reorientation.spec.ts \
  src/remediation/ticket-remediation.spec.ts \
  src/remediation/stale-pull-request-cleanup.service.spec.ts \
  src/google-chat/google-chat-actions.service.spec.ts \
  src/git/git.spec.ts
```

Expected: PASS with no external GitHub calls.

- [ ] **Step 3: Run repository-wide checks**

```bash
npm run build
npm run lint
npm test
npm run format:check
```

Expected: all commands exit zero.

- [ ] **Step 4: Inspect built entrypoints**

```bash
node --check dist/github/gh-wrapper.js
node --check dist/github/git-credential-app.js
head -n 1 dist/github/gh-wrapper.js
head -n 1 dist/github/git-credential-app.js
```

Expected: valid JavaScript and preserved Node shebangs.

- [ ] **Step 5: Build the container and test static helper behavior without network mutation**

```bash
docker build -t driva-ops-agent:github-app-test .
docker run --rm --entrypoint sh driva-ops-agent:github-app-test -c \
  'test -x /app/dist/github/gh-wrapper.js && test -x /app/dist/github/git-credential-app.js && test -L /app/github-bin/gh && git config --global --get-all credential.https://github.com.helper'
```

Expected: wrapper/helper are executable, symlink exists, and Git prints the configured helper command.

- [ ] **Step 6: Review the final diff for forbidden capability expansion**

```bash
git diff origin/main...HEAD -- . ':!package-lock.json' | \
  grep -E "workflow|admin|deploy|merge|bypass|private.?key|GH_TOKEN" || true
```

Manually confirm matches are configuration, tests, documentation, or explicit denials; no code introduces merge/deploy/admin/bypass behavior, and no secret value is present.

- [ ] **Step 7: Commit verification fixes if needed**

If verification required code changes, stage only those fixes and commit:

```bash
git add <verified-fix-files>
git commit -m "fix: complete GitHub App verification"
```

If no files changed, do not create an empty commit.

- [ ] **Step 8: Prepare the production cutover checklist**

Before deployment, record these operator confirmations in the PR description:

- existing App is organization-owned;
- selected repositories include all configured product repos and LinkedIn submodules;
- permissions match the spec exactly;
- no branch/ruleset bypass is granted;
- PEM is mounted read-only at the configured path;
- explicit service Git author/committer identity is configured;
- `GITHUB_DDS_TOKEN` remains available;
- rollback `GH_TOKEN` is retained until one controlled App-mode remediation succeeds.

---

## Spec Coverage Check

- Organization-owned App and selected repositories: Tasks 1, 9, and 10.
- Metadata/Contents/PR/Issues/Actions/Checks permissions and denied capabilities: Tasks 9 and 10.
- Renewable JWT and installation token: Task 2.
- Static rollback mode: Tasks 1, 2, 6, 7, and 9.
- Controlled Nest and runner `gh` calls: Tasks 4 and 5.
- Long-running Codex remediation: Task 6.
- Late Git fetch/push and private submodules: Task 7.
- Commit identity separation: Tasks 7 and 9.
- App-aware health and remediation preflight: Tasks 5 and 8.
- Secret sanitization and environment isolation: Tasks 3, 4, 6, and 7.
- GitHub Packages excluded and preserved: Tasks 1, 8, 9, and 10.
- Rollout and rollback: Tasks 9 and 10.
- Full build, lint, test, formatting, and container verification: Task 10.
