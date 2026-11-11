# Storage Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure and safely control `state/dependency-cache` and `repos` growth through manual calibration followed by automatic hybrid cleanup.

**Architecture:** Add an isolated `storage-maintenance` feature with typed configuration, filesystem inventory, pure cleanup policy, a standalone child-process CLI, and a Nest scheduler. Incremental ecosystem cleanup runs first; a coordinated dependency reset runs only when the cache remains above target. Maintenance shares the diagnosis/remediation execution queue and lock.

**Tech Stack:** Node.js 24, TypeScript strict/NodeNext, NestJS 11, Vitest, `cron`, existing process/Git/state helpers.

**Spec:** `docs/superpowers/specs/2026-10-03-storage-maintenance-design.md`

## Global Constraints

- Never read, remove, or modify `results/`, `secrets/`, or authoritative `state/*.json`, except `dependency-fingerprints.json` during coordinated reset and the dedicated maintenance state if later required.
- Never delete configured repository source, Git history, remotes, branches, or clone directories.
- Keep long cleanup work in a child process, not the Nest process.
- Serialize maintenance with diagnosis and remediation, and acquire the existing diagnosis lock.
- Read `process.env` only in `src/config/` and CLI entrypoints.
- Use adapters for filesystem, Git, dependency commands, and subprocesses.
- Every subprocess has an allowlisted environment, timeout, stderr capture, and non-zero exit handling.
- Automatic maintenance starts disabled; thresholds are configured only after manual calibration.
- Log only structured operational metadata to Dokku; never log file contents or credentials.
- Use TDD and preserve existing diagnosis/remediation behavior.

## Review Focus

- Missing thresholds while automatic maintenance is enabled must fail boot; manual dry-run without thresholds must still work.
- A cache crossing the high limit but falling below target after incremental cleanup must not trigger coordinated reset.
- A dependency rebuild failure must report failed maintenance and leave the next dependency sync able to retry.
- A manual maintenance process holding the lock must make the scheduled run skip safely, not fail diagnosis state.
- Repository discovery must never make a clone directory eligible for deletion.

**Integration note:** while this branch was in review, `main` replaced the singleton execution queue and `diagnosis.lock` with a concurrent execution pool plus owned repository-reader/synchronization leases. The merged implementation keeps that architecture: storage maintenance acquires exclusive repository access through `repository-access.ts`, skips when readers are live, and does not restore the removed queue or lock.

---

## Planned File Structure

### New files

- `src/config/storage-maintenance-config.ts` — typed env parsing and validation.
- `src/config/storage-maintenance-config.spec.ts` — config contract tests.
- `src/storage-maintenance/storage-maintenance.types.ts` — inventory, plan, action, and report contracts.
- `src/storage-maintenance/storage-inventory.ts` — filesystem and repository size inventory.
- `src/storage-maintenance/storage-inventory.spec.ts` — inventory/protected-path tests.
- `src/storage-maintenance/storage-policy.ts` — pure hybrid cleanup decision.
- `src/storage-maintenance/storage-policy.spec.ts` — threshold and action-order tests.
- `src/storage-maintenance/storage-cleanup.ts` — incremental cleanup, Git maintenance, worktree cleanup, and coordinated reset.
- `src/storage-maintenance/storage-cleanup.spec.ts` — mutation boundary tests.
- `src/storage-maintenance/storage-maintenance-runner.ts` — standalone CLI entrypoint.
- `src/storage-maintenance/storage-maintenance-runner.spec.ts` — dry-run/execute/lock/report tests.
- `src/storage-maintenance/storage-maintenance-execution.service.ts` — Nest child-process adapter.
- `src/storage-maintenance/storage-maintenance.scheduler.ts` — disabled-by-default cron.
- `src/storage-maintenance/storage-maintenance.scheduler.spec.ts` — cron behavior tests.
- `src/storage-maintenance/storage-maintenance.module.ts` — feature module.
- `src/diagnosis/diagnosis-execution-queue.service.ts` — shared singleton queue.
- `src/diagnosis/diagnosis-execution-queue.service.spec.ts` — serialization tests.

### Focused modifications

- `src/config/config.module.ts` — register/export storage config.
- `src/git/dependencies.ts` — expose managed installation paths and reusable dependency reset/sync inputs.
- `src/git/dependencies.spec.ts` — dependency reset contract.
- `src/git/git.ts` — reuse existing `runGit` for `gc --auto`; no new spawn path.
- `src/runner/runner-lock.ts` — allow the shared lock to receive an owner label/project path without changing diagnosis behavior.
- `src/runner/runner-paths.ts` — expose maintenance paths.
- `src/diagnosis/diagnosis-execution.service.ts` — replace private promise queue with shared queue.
- `src/diagnosis/diagnosis.module.ts` — provide/export shared queue.
- `src/app.module.ts` — import `StorageMaintenanceModule`.
- `package.json` — add `storage-maintenance` script.
- `.env.example` and `docs/DEPLOY_HANDOFF.md` — config and rollout instructions.

---

### Task 1: Add typed maintenance configuration

**Files:**

- Create: `src/config/storage-maintenance-config.ts`
- Create: `src/config/storage-maintenance-config.spec.ts`
- Modify: `src/config/config.module.ts:1-28`
- Modify: `.env.example:141-157`

**Interfaces:**

```typescript
export interface StorageMaintenanceConfig {
  enabled: boolean;
  cron: string;
  dependencyCacheHighBytes?: number;
  dependencyCacheTargetBytes?: number;
  worktreeMinAgeMs: number;
  timeoutMs: number;
}

export const STORAGE_MAINTENANCE_CONFIG = Symbol('STORAGE_MAINTENANCE_CONFIG');
export function storageMaintenanceConfig(
  env?: Environment,
): StorageMaintenanceConfig;
```

- [ ] **Step 1: Write failing config tests**

Cover disabled config without limits, enabled config with valid limits, target equal/above high, missing enabled limits, invalid cron, and non-positive size/duration values.

```typescript
it('requires calibrated limits only when automation is enabled', () => {
  expect(() =>
    storageMaintenanceConfig({ STORAGE_MAINTENANCE_ENABLED: 'true' }),
  ).toThrow('STORAGE_DEPENDENCY_CACHE_HIGH_MB is required');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

```bash
npm test -- src/config/storage-maintenance-config.spec.ts
```

Expected: FAIL because the config does not exist.

- [ ] **Step 3: Implement parsing and register the global token**

Use `validateCronExpression`, strict booleans, positive integers, MiB-to-byte conversion, default cron `43 3 * * *`, default worktree age `24h`, and default timeout `90m`. Export the token from `ConfigModule`.

- [ ] **Step 4: Document the variables in `.env.example`**

Add the exact variables from the spec with `STORAGE_MAINTENANCE_ENABLED=false` and blank cache limits.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/config/storage-maintenance-config.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/storage-maintenance-config.ts src/config/storage-maintenance-config.spec.ts src/config/config.module.ts .env.example
git commit -m "feat: add storage maintenance configuration"
```

---

### Task 2: Build inventory and pure cleanup policy

**Files:**

- Create: `src/storage-maintenance/storage-maintenance.types.ts`
- Create: `src/storage-maintenance/storage-inventory.ts`
- Create: `src/storage-maintenance/storage-inventory.spec.ts`
- Create: `src/storage-maintenance/storage-policy.ts`
- Create: `src/storage-maintenance/storage-policy.spec.ts`
- Modify: `src/runner/runner-paths.ts:8-19`

**Interfaces:**

```typescript
export interface StorageInventory {
  authoritativeStateBytes: number;
  dependencyCacheBytes: number;
  cacheBytesByKind: Record<'npm' | 'pnpm' | 'goBuild' | 'goMod', number>;
  repositories: Array<{
    name: string;
    directory: string;
    totalBytes: number;
    gitBytes: number;
    dependencyBytes: number;
  }>;
  orphanWorktrees: Array<{ directory: string; ageMs: number; bytes: number }>;
}

export type StorageAction =
  | { type: 'prune-dependency-caches' }
  | { type: 'git-gc'; repository: string }
  | { type: 'remove-orphan-worktree'; directory: string }
  | { type: 'coordinated-dependency-reset' };

export function planStorageMaintenance(input: {
  inventory: StorageInventory;
  highBytes?: number;
  targetBytes?: number;
  execute: boolean;
}): StorageAction[];
```

- [ ] **Step 1: Write failing inventory tests**

Use a temporary directory fixture containing state JSON, dependency cache, one Git repository shape, `node_modules`, and a `results/forbidden` sentinel. Assert totals exclude `results`, secrets, and file contents from output.

- [ ] **Step 2: Write failing policy tests**

Pin these decisions:

```typescript
expect(
  planStorageMaintenance({
    inventory: belowHigh,
    highBytes,
    targetBytes,
    execute: true,
  }),
).not.toContainEqual({ type: 'prune-dependency-caches' });

expect(
  planStorageMaintenance({
    inventory: aboveHigh,
    highBytes,
    targetBytes,
    execute: true,
  })[0],
).toEqual({ type: 'prune-dependency-caches' });
```

The coordinated reset is not planned until a post-prune inventory remains above target.

- [ ] **Step 3: Run tests and verify failure**

```bash
npm test -- src/storage-maintenance/storage-inventory.spec.ts src/storage-maintenance/storage-policy.spec.ts
```

Expected: FAIL because inventory and policy do not exist.

- [ ] **Step 4: Implement recursive byte counting and protected roots**

Inject filesystem operations for tests. Discover repositories with existing `findGitRepositories`. Discover only `/tmp/driva-remediation-*` worktree parents older than the configured age; maintenance owns the diagnosis lock before inventory, so no active runner can own them.

- [ ] **Step 5: Implement the pure policy**

Always plan Git `gc --auto` and eligible orphan cleanup during execute. Plan cache prune only when high is crossed. Let the orchestrator re-inventory after prune and call the policy again for the reset decision.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/storage-maintenance/storage-inventory.spec.ts src/storage-maintenance/storage-policy.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage-maintenance/storage-maintenance.types.ts src/storage-maintenance/storage-inventory.ts src/storage-maintenance/storage-inventory.spec.ts src/storage-maintenance/storage-policy.ts src/storage-maintenance/storage-policy.spec.ts src/runner/runner-paths.ts
git commit -m "feat: inventory storage maintenance targets"
```

---

### Task 3: Implement hybrid cleanup and coordinated dependency reset

**Files:**

- Create: `src/storage-maintenance/storage-cleanup.ts`
- Create: `src/storage-maintenance/storage-cleanup.spec.ts`
- Modify: `src/git/dependencies.ts:15-236`
- Modify: `src/git/dependencies.spec.ts`

**Interfaces:**

```typescript
export interface StorageCleanupDependencies {
  runProcess: typeof runProcess;
  runGit: typeof runGit;
  remove: (path: string) => Promise<void>;
  synchronizeDependencies: typeof synchronizeDependencies;
}

export async function executeStorageActions(
  actions: readonly StorageAction[],
  config: StorageCleanupConfig,
  dependencies?: Partial<StorageCleanupDependencies>,
): Promise<StorageActionResult[]>;

export function dependencyInstallationPaths(
  reposDir: string,
): readonly string[];
```

- [ ] **Step 1: Write failing incremental-cleanup tests**

Assert explicit commands and paths:

- npm: clean the dedicated npm cache with `--force`;
- pnpm: `store prune` against the dedicated store;
- Go: `go clean -cache -modcache` with dedicated `GOCACHE` and `GOMODCACHE`;
- Git: call existing `runGit(config, repo, ['gc', '--auto'])`;
- orphan worktree: remove only the planned absolute directory.

Also assert timeout, non-zero exit, and sanitized stderr propagation.

- [ ] **Step 2: Write failing coordinated-reset tests**

Assert one reset removes only dependency cache, dependency fingerprints, managed npm/pnpm `node_modules`, and Go markers, then invokes `synchronizeDependencies` exactly once. Include the Review Focus case where rebuild rejects and the action/report remains failed.

- [ ] **Step 3: Run tests and verify failure**

```bash
npm test -- src/storage-maintenance/storage-cleanup.spec.ts src/git/dependencies.spec.ts
```

Expected: FAIL because cleanup helpers do not exist.

- [ ] **Step 4: Expose managed installation paths from dependency sync**

Derive them from the existing `dependencyProjects()` source of truth. Do not duplicate repository names or manager literals.

- [ ] **Step 5: Implement cleanup through existing adapters**

Use `runProcess` for ecosystem commands, `runGit` for Git, `rm(..., { recursive: true, force: true })` behind the injected remove boundary, and existing `synchronizeDependencies` for rebuild. Reject any planned deletion outside the exact cache, fingerprint, managed installation, or `/tmp/driva-remediation-*` roots.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/storage-maintenance/storage-cleanup.spec.ts src/git/dependencies.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage-maintenance/storage-cleanup.ts src/storage-maintenance/storage-cleanup.spec.ts src/git/dependencies.ts src/git/dependencies.spec.ts
git commit -m "feat: add hybrid storage cleanup"
```

---

### Task 4: Add the manual maintenance CLI

**Files:**

- Create: `src/storage-maintenance/storage-maintenance-runner.ts`
- Create: `src/storage-maintenance/storage-maintenance-runner.spec.ts`
- Modify: `src/runner/runner-lock.ts:6-29`
- Modify: `package.json:6-21`

**Interfaces:**

```typescript
export interface StorageMaintenanceArgs {
  execute: boolean;
  trigger: 'manual' | 'cron';
}

export async function runStorageMaintenance(
  args: StorageMaintenanceArgs,
  dependencies?: Partial<StorageMaintenanceRunnerDependencies>,
): Promise<StorageMaintenanceReport>;
```

- [ ] **Step 1: Write failing CLI tests**

Cover default dry-run, explicit `--dry-run`, explicit `--execute`, mutually exclusive flags, lock conflict safe exit, before/prune/after inventory, reset only after post-prune target check, and structured summary fields.

- [ ] **Step 2: Run tests and verify failure**

```bash
npm test -- src/storage-maintenance/storage-maintenance-runner.spec.ts
```

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Generalize the existing lock owner metadata**

Change the lock API without changing diagnosis behavior:

```typescript
export async function acquireDiagnosisLock(
  owner = 'diagnosis',
): Promise<() => Promise<void>>;
```

Write `{ pid, owner, started_at }` with mode `0600`. Maintenance uses owner `storage-maintenance`.

- [ ] **Step 4: Implement orchestration and logging**

Load dotenv only in the entrypoint. Inventory first, emit key-value logs through the runner logger, return without mutation for dry-run, execute incremental actions, re-inventory, conditionally reset/rebuild, and always release the lock in `finally`.

- [ ] **Step 5: Add the package script**

```json
"storage-maintenance": "node dist/storage-maintenance/storage-maintenance-runner.js"
```

- [ ] **Step 6: Run focused tests and build**

```bash
npm test -- src/storage-maintenance/storage-maintenance-runner.spec.ts
npm run build
node --check dist/storage-maintenance/storage-maintenance-runner.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage-maintenance/storage-maintenance-runner.ts src/storage-maintenance/storage-maintenance-runner.spec.ts src/runner/runner-lock.ts package.json
git commit -m "feat: add storage maintenance CLI"
```

---

### Task 5: Serialize and schedule automatic maintenance

**Files:**

- Create: `src/diagnosis/diagnosis-execution-queue.service.ts`
- Create: `src/diagnosis/diagnosis-execution-queue.service.spec.ts`
- Modify: `src/diagnosis/diagnosis-execution.service.ts:58-153`
- Modify: `src/diagnosis/diagnosis.module.ts:1-14`
- Create: `src/storage-maintenance/storage-maintenance-execution.service.ts`
- Create: `src/storage-maintenance/storage-maintenance.scheduler.ts`
- Create: `src/storage-maintenance/storage-maintenance.scheduler.spec.ts`
- Create: `src/storage-maintenance/storage-maintenance.module.ts`
- Modify: `src/app.module.ts:1-23`

**Interfaces:**

```typescript
@Injectable()
export class DiagnosisExecutionQueueService {
  enqueue<T>(work: () => Promise<T>): Promise<T>;
}

@Injectable()
export class StorageMaintenanceExecutionService {
  execute(trigger: 'cron'): Promise<number>;
}
```

- [ ] **Step 1: Write failing queue tests**

Use deferred promises to prove diagnosis, reorientation, and maintenance tasks never overlap and that one rejection does not block the next queued task.

- [ ] **Step 2: Extract the singleton queue**

Provide/export it only from `DiagnosisModule`. Inject it into `DiagnosisExecutionService` and replace both uses of the private promise chain without changing public diagnosis behavior.

- [ ] **Step 3: Run diagnosis queue regression tests**

```bash
npm test -- src/diagnosis/diagnosis-execution-queue.service.spec.ts src/diagnosis/diagnosis-execution.service.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Write failing scheduler tests**

Cover disabled debug log/no spawn, enabled queue/spawn, duplicate in-flight tick skip, child non-zero exit, lock-conflict exit as warning/skip, and caught rejection with `error` log.

- [ ] **Step 5: Implement child execution and scheduler**

Spawn:

```typescript
[
  fileURLToPath(new URL('./storage-maintenance-runner.js', import.meta.url)),
  '--execute',
  '--trigger=cron',
];
```

Use the shared queue, `RuntimeConfig.processEnv`, configured timeout, inherited stdio, and a tracked child terminated during Nest shutdown. The scheduler follows the existing `CronJob.from` and explicit `try/catch/finally` pattern.

- [ ] **Step 6: Register the feature module**

`StorageMaintenanceModule` imports `DiagnosisModule`, provides the execution service and scheduler, and is imported once by `AppModule`.

- [ ] **Step 7: Run scheduler and regression tests**

```bash
npm test -- \
  src/diagnosis/diagnosis-execution-queue.service.spec.ts \
  src/diagnosis/diagnosis-execution.service.spec.ts \
  src/diagnosis/diagnosis.scheduler.spec.ts \
  src/storage-maintenance/storage-maintenance.scheduler.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/diagnosis/diagnosis-execution-queue.service.ts src/diagnosis/diagnosis-execution-queue.service.spec.ts src/diagnosis/diagnosis-execution.service.ts src/diagnosis/diagnosis.module.ts src/storage-maintenance/storage-maintenance-execution.service.ts src/storage-maintenance/storage-maintenance.scheduler.ts src/storage-maintenance/storage-maintenance.scheduler.spec.ts src/storage-maintenance/storage-maintenance.module.ts src/app.module.ts
git commit -m "feat: schedule serialized storage maintenance"
```

---

### Task 6: Document rollout and verify the full feature

**Files:**

- Modify: `README.md`
- Modify: `docs/DEPLOY_HANDOFF.md`
- Modify only implementation files required by verification failures.

- [ ] **Step 1: Document the operator flow**

Document:

```bash
npm run storage-maintenance -- --dry-run
npm run storage-maintenance -- --execute
```

Include calibration fields to capture, enabling thresholds only afterward, Dokku log inspection, one controlled diagnosis after rebuild, and rollback with `STORAGE_MAINTENANCE_ENABLED=false`.

- [ ] **Step 2: Run focused storage suites**

```bash
npm test -- \
  src/config/storage-maintenance-config.spec.ts \
  src/storage-maintenance/storage-inventory.spec.ts \
  src/storage-maintenance/storage-policy.spec.ts \
  src/storage-maintenance/storage-cleanup.spec.ts \
  src/storage-maintenance/storage-maintenance-runner.spec.ts \
  src/storage-maintenance/storage-maintenance.scheduler.spec.ts \
  src/diagnosis/diagnosis-execution-queue.service.spec.ts \
  src/git/dependencies.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository-wide verification**

```bash
npm run build
npm run lint
npm test
npm run format:check
```

Expected: all commands exit zero.

- [ ] **Step 4: Inspect the final deletion boundary**

```bash
grep -R "rm(\|remove(" -n src/storage-maintenance src/git/dependencies.ts
```

Confirm every recursive deletion is guarded to one of: dependency cache, dependency fingerprints, managed dependency installation, or known temporary worktree root. Confirm no `results` or `secrets` mutation exists.

- [ ] **Step 5: Commit documentation and verification fixes**

```bash
git add README.md docs/DEPLOY_HANDOFF.md
# Add only verified implementation fixes if Step 3 required them.
git commit -m "docs: add storage maintenance rollout"
```

---

## Spec Coverage Check

- Inventory and Dokku logs: Tasks 2 and 4.
- Manual dry-run/execute calibration: Task 4.
- Incremental ecosystem cleanup: Task 3.
- Git maintenance and orphan worktrees: Tasks 2 and 3.
- Coordinated reset and rebuild: Task 3.
- Typed thresholds and disabled-by-default cron: Tasks 1 and 5.
- Shared queue, child isolation, lock, shutdown, and error containment: Tasks 4 and 5.
- Protected paths and no clone deletion: Tasks 2, 3, and 6.
- Tests, rollout, and rollback: Task 6.
