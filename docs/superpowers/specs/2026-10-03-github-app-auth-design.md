# GitHub App authentication design

**Date:** 2026-10-03
**Status:** Draft for review

## 1. Purpose

Replace the personal GitHub token used by the ops agent with an organization-owned GitHub App while preserving the current diagnosis, remediation, incident, cleanup, and Google Chat flows.

The migration must:

- attribute GitHub operations to the App bot instead of a personal account;
- support installation tokens that expire after one hour;
- keep long remediations working when GitHub access occurs after the initial token expires;
- preserve the current autonomous Codex remediation model;
- limit access through App permissions and selected repositories;
- retain a temporary static-token mode for development and rollback;
- avoid changing the GitHub Packages credential in this delivery.

This design intentionally accepts that the Codex remediation environment can invoke the token-producing helpers and therefore can obtain the App's effective installation privileges. The security boundary is the App installation and its permissions, not process-level isolation inside the container.

## 2. Current behavior

The application currently assumes a long-lived `GH_TOKEN` in the container environment.

GitHub access is used for:

1. fetching and resetting product repositories against `origin/main`;
2. initializing private Git submodules;
3. creating remediation branches, commits, pushes, and pull requests;
4. reading, editing, reusing, superseding, and closing pull requests;
5. deleting stale pull-request branches;
6. creating, finding, commenting on, assigning, and closing incident issues;
7. linking issues and pull requests across repositories;
8. reading pull-request checks and GitHub Actions runs during remediation;
9. checking `gh` authentication in the health endpoint.

The remediation subprocess may run for 90 minutes. Passing one installation token in its initial environment is insufficient because an installation token expires after one hour.

`GITHUB_DDS_TOKEN`, used to download a private npm package from GitHub Packages for `service-17`, is an independent credential and remains unchanged.

## 3. Selected approach

Introduce a shared, non-Nest `GitHubCredentialProvider` and executable helpers for `gh` and Git HTTPS authentication.

The provider reads the GitHub App configuration, signs a short-lived JWT, resolves the organization installation, creates an installation access token, caches it in memory, and renews it before expiration.

```text
Nest / runner / Codex
        │
        ├── controlled gh adapter ──┐
        ├── gh wrapper ─────────────┤
        └── Git credential helper ──┤
                                    ▼
                       GitHubCredentialProvider
                       - sign App JWT
                       - resolve installation
                       - mint installation token
                       - cache until refresh skew
                                    │
                                    ▼
                              GitHub API
```

There is no local broker, socket protocol, dedicated Unix user, KMS integration, or separate service in this delivery.

## 4. GitHub App configuration

The existing GitHub App must belong to the organization and be installed with **Only select repositories**.

### 4.1 Repository permissions

| Permission     | Access         | Purpose                                                          |
| -------------- | -------------- | ---------------------------------------------------------------- |
| Metadata       | Read-only      | Repository metadata required by GitHub APIs                      |
| Contents       | Read and write | Fetch, push, branch creation, and stale branch deletion          |
| Pull requests  | Read and write | Create, inspect, edit, comment on, and close pull requests       |
| Issues         | Read and write | Create, inspect, comment on, assign, and close incident issues   |
| Actions        | Read-only      | Inspect workflow runs and jobs during remediation                |
| Checks         | Read-only      | Inspect check runs and pull-request checks                       |
| Workflows      | No access      | The agent must not modify workflow files                         |
| Administration | No access      | The agent must not alter repository configuration or protections |
| Deployments    | No access      | The agent must not deploy                                        |
| Environments   | No access      | The agent does not manage deployment environments                |

No organization permission is required for the current behavior. In particular, `Members: read` is unnecessary because Google Chat identities are mapped to GitHub logins through `GITHUB_CHAT_USER_MAP`.

The App must not receive branch-protection or ruleset bypass. It pushes feature branches and opens pull requests; human review remains responsible for merging.

### 4.2 Repository selection

The installation must include:

- every product repository configured for diagnosis or remediation;
- private repositories referenced as Git submodules by those products;
- newly onboarded repositories before their first production diagnosis.

Repository selection in the GitHub installation is the primary blast-radius boundary. The application also validates the configured organization and expected repositories before mutable operations.

## 5. Application configuration

Add an authentication-mode discriminator and App configuration to the typed config layer.

```env
# static | app
GITHUB_AUTH_MODE=app

# Required when GITHUB_AUTH_MODE=app
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_ORGANIZATION=Example-org
GITHUB_APP_HEALTH_REPOSITORY=service-15
GITHUB_APP_PRIVATE_KEY_FILE=/app/secrets/github-app-private-key.pem

# Optional override; otherwise resolved from the organization
GITHUB_APP_INSTALLATION_ID=

# Renew tokens this many seconds before expires_at
GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS=300
```

Static compatibility mode continues to use:

```env
GITHUB_AUTH_MODE=static
GH_TOKEN=
```

Validation rules:

- `GITHUB_AUTH_MODE` must be `static` or `app`;
- static mode requires `GH_TOKEN`;
- App mode requires App ID, client ID, organization, a selected health-check repository, and a readable private-key file;
- installation ID, when provided, must be a positive integer;
- refresh skew must be positive and materially less than the one-hour token lifetime;
- invalid or mixed configuration fails at boot with a clear message;
- `process.env` remains read only inside `src/config/`.

The private key is mounted read-only at runtime. It must not be committed, copied into the image, placed in `.env`, written to `state/` or `results/`, or included in logs.

## 6. Credential provider

Create a framework-independent provider under the GitHub feature boundary so Nest and runner code reuse the same implementation.

### 6.1 Responsibilities

The provider:

1. reads the PEM once during initialization;
2. creates an RS256 JWT using `node:crypto`;
3. sets `iat` with clock-skew tolerance and `exp` within GitHub's ten-minute JWT limit;
4. resolves the installation through the configured installation ID or the organization endpoint;
5. calls `POST /app/installations/{id}/access_tokens`;
6. validates the returned token and `expires_at` as external `unknown` data;
7. caches the token in memory until `expires_at - refreshSkew`;
8. coalesces concurrent refresh requests into one in-flight promise;
9. invalidates the cache on an authentication-expiration response;
10. never exposes the PEM or token in errors or logs.

The implementation uses built-in `node:crypto` and `fetch`; no SDK dependency is required for this protocol.

### 6.2 Token scope

The initial implementation uses the permissions and repository selection of the App installation. Per-operation `repository_ids` narrowing is not required because commands may span repositories during one runner execution and the installation is already restricted to selected repositories.

The provider interface must allow future narrowing without changing consumers.

### 6.3 Static provider

Static mode implements the same provider interface and returns the configured `GH_TOKEN`. Consumers do not branch on the authentication mode.

## 7. Controlled `gh` calls

The existing GitHub adapter obtains a token immediately before each `gh` subprocess and injects it as `GH_TOKEN`.

The subprocess environment becomes an allowlist containing only values required by `gh`, including:

- `PATH`;
- `HOME` when required by the CLI;
- certificate variables;
- proxy variables required in production;
- `GH_TOKEN`;
- `GH_PROMPT_DISABLED=true`.

The adapter no longer forwards the full application environment.

On a 401 caused by an expired installation token, the adapter invalidates the cached token and retries once when the operation is safe to retry. Permission failures, rate limits, validation failures, and network errors are not treated as token expiration.

## 8. Codex `gh` wrapper

Add a TypeScript CLI entrypoint compiled into `dist/` that acts as the `gh` executable for remediation subprocesses.

The wrapper:

1. loads typed GitHub auth configuration;
2. obtains a current credential from the shared provider;
3. starts the real GitHub CLI with `GH_TOKEN` set;
4. forwards arguments, cwd, stdio, exit code, and termination signals;
5. sanitizes errors without changing normal `gh` output semantics.

The remediation subprocess receives a `PATH` whose first entry contains the wrapper. The real binary remains available through a fixed internal path that the wrapper invokes directly, avoiding recursion.

The remediation Codex environment no longer receives a fixed `GH_TOKEN` in App mode. Static mode may use the same wrapper so behavior is consistent across modes.

## 9. Git HTTPS credential helper

Add a TypeScript Git credential helper compiled into `dist/`.

For the Git credential protocol:

- `get` for `github.com` returns `username=x-access-token` and a current provider token;
- unsupported hosts return no credential;
- `store` and `erase` do not persist installation tokens;
- token and PEM values never go to stderr;
- input is parsed as untrusted external data.

The container entrypoint configures Git to:

- rewrite GitHub SSH remotes to credential-free HTTPS URLs;
- use the App credential helper;
- keep the existing Git author configuration.

The rewrite and credential-helper configuration are based on `GITHUB_AUTH_MODE`, not on the presence of a static `GH_TOKEN`.

This allows `git fetch`, submodule operations, and a `git push` late in a 90-minute remediation to obtain a current token at authentication time.

## 10. Commit and actor identity

Authentication identity and Git commit identity remain separate:

- pushes, pull requests, issues, and comments appear as the GitHub App bot;
- commit author and committer remain controlled by `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL`;
- migration must not silently retain the developer's personal identity as the configured bot identity.

The deployment must define an explicit service identity for commits. Commit signing is outside this delivery.

## 11. Health and preflight

Health reporting distinguishes:

- authentication mode;
- private-key readability in App mode;
- successful JWT and installation-token creation;
- installation identity and token expiration, without exposing credentials;
- access to a configured canary repository;
- GitHub Packages health as a separate concern.

Before automatic remediation, a preflight obtains a fresh token and confirms enough remaining validity to begin. The wrapper and credential helper still renew credentials during the remediation, so preflight does not assume the initial token will last for the entire run.

`gh auth status` is no longer the sole authorization check in App mode because it does not verify the required repository permissions.

## 12. Error handling and observability

The implementation logs:

- authentication mode;
- App and installation identifiers;
- token expiration timestamp or remaining lifetime;
- repository and operation category;
- refresh failures;
- access or permission failures.

It never logs:

- App private-key material;
- JWTs;
- installation access tokens;
- authenticated remote URLs;
- authorization headers.

Sanitization covers:

- classic and fine-grained PAT formats;
- installation-token formats;
- generic Bearer and token authorization headers;
- `x-access-token:<secret>@github.com` URLs;
- credential-helper protocol output in error paths.

A GitHub authentication failure must fail only the affected external operation. Existing domain guarantees remain unchanged: a notification failure does not fail diagnosis, and failure for one ticket does not abort unrelated tickets.

## 13. Tests

All tests mock network and subprocess boundaries. No test calls GitHub.

Required coverage:

### Configuration

- valid static mode;
- valid App mode;
- missing App fields;
- unreadable PEM;
- invalid installation ID and refresh skew;
- mutually inconsistent mode configuration;
- `.env.example` remains synchronized with typed config.

### Provider

- JWT claims and RS256 signature behavior;
- organization installation resolution;
- explicit installation-ID override;
- external response validation;
- token caching before refresh skew;
- renewal after refresh skew;
- concurrent refresh coalescing;
- cache invalidation;
- redacted failures.

### `gh` integration

- current token injected per call;
- environment allowlist;
- no fixed App token inherited by Codex;
- one expiration retry where safe;
- permission and rate-limit errors not retried as expiration;
- wrapper forwards arguments, cwd, output, signals, and exit status.

### Git credential helper

- credentials returned only for GitHub HTTPS;
- `x-access-token` username;
- fresh token acquisition;
- no persistence for `store` or `erase`;
- malformed input handled without secret leakage.

### Existing behavior

Regression tests continue to cover:

- repository synchronization and submodules;
- issue creation, reuse, assignment, comments, and closing;
- pull-request creation contract, reuse, supersession, and cleanup;
- stale branch deletion;
- remediation and reorientation;
- health degradation;
- diagnosis and impact flows not receiving unnecessary GitHub credentials.

## 14. Deployment and rollout

### Phase 1: GitHub configuration

1. confirm the existing App is owned by the organization;
2. apply the repository permissions in this specification;
3. install it with selected repositories, including private submodules;
4. confirm no branch-protection or ruleset bypass;
5. record App ID, client ID, organization, and optional installation ID;
6. mount the existing private key as a read-only runtime secret.

### Phase 2: compatibility deployment

1. deploy the code with `GITHUB_AUTH_MODE=static` and the existing `GH_TOKEN`;
2. verify build, health, repository sync, diagnosis, incident issues, and remediation remain unchanged;
3. verify wrapper and credential-helper behavior in static mode.

### Phase 3: App cutover

1. set the App configuration and private-key mount;
2. switch to `GITHUB_AUTH_MODE=app`;
3. restart the single Dokku process;
4. verify health and installation access;
5. run repository sync;
6. run one controlled diagnosis/remediation against a selected repository;
7. verify bot attribution, branch push, pull request, issue comments, checks, and cleanup visibility;
8. remove `GH_TOKEN` only after the App path is validated.

Rollback consists of restoring `GITHUB_AUTH_MODE=static` and `GH_TOKEN`, then restarting the process. No state migration is required.

## 15. Out of scope

This delivery does not:

- migrate `GITHUB_DDS_TOKEN` or GitHub Packages authentication;
- create or register a new GitHub App;
- add GitHub App webhooks;
- add KMS, Vault, a token broker, socket protocol, sidecar, or second container;
- isolate the private key from Codex through an OS security boundary;
- remove mutable GitHub operations from Codex;
- change remediation eligibility or decision semantics;
- change notification, ClickUp, issue, pull-request reuse, supersession, or cleanup behavior;
- grant merge, deploy, workflow-write, administration, or ruleset-bypass permissions;
- sign commits.

## 16. Success criteria

The migration is complete when:

1. production runs with `GITHUB_AUTH_MODE=app` and no personal `GH_TOKEN`;
2. repository sync and private submodules work through HTTPS;
3. a remediation longer than one token lifetime can still push and open or update a pull request;
4. pull requests, issues, comments, and pushes are attributed to the App bot;
5. existing issue, pull-request reuse, supersession, reorientation, and cleanup behavior is preserved;
6. Actions and checks remain readable without workflow-write access;
7. the App is limited to selected repositories and has no merge/deploy/admin bypass;
8. App private keys, JWTs, and installation tokens do not appear in logs, state, or result artifacts;
9. `GITHUB_DDS_TOKEN` continues to work independently;
10. `npm run build`, `npm run lint`, and `npm test` pass.
