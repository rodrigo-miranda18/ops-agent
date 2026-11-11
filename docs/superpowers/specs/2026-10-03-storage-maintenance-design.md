# Storage maintenance design

**Date:** 2026-10-03
**Status:** Approved for planning

## 1. Purpose

Control the growth of `state/dependency-cache` and `repos` without touching `results`, secrets, or authoritative state files.

The delivery has two rollout phases:

1. measure, log, and run the first cleanup manually to calibrate thresholds;
2. enable automatic daily cleanup using the calibrated limits.

Only Dokku logs are required. No dashboard, external metric backend, or Chat notification is included.

## 2. Scope

The maintenance process covers:

- `state/dependency-cache`;
- `state/dependency-fingerprints.json` only during a coordinated reset;
- dependency installations under active repositories;
- Git maintenance for active repositories;
- temporary orphaned worktrees.

It never removes or modifies:

- `results/`;
- `secrets/`;
- other `state/*.json` files;
- configured repository source or Git history;
- active worktrees or a repository currently used by diagnosis/remediation.

## 3. Selected approach

Use hybrid cleanup:

1. inventory current storage;
2. run ecosystem-native cache cleanup;
3. run `git gc --auto` for active repositories and remove eligible orphaned worktrees;
4. measure again;
5. when the dependency cache remains above the target, perform a coordinated reset of cache, fingerprints, and dependent installations;
6. immediately synchronize dependencies again;
7. log the final report.

The first execution is manual. Automatic execution remains disabled until its result is reviewed and production limits are configured.

## 4. Architecture

Create an isolated `storage-maintenance` feature with:

- a plain TypeScript inventory adapter for filesystem sizes and repository classification;
- a pure policy function that converts inventory and configuration into a cleanup plan;
- a maintenance orchestrator that executes the plan and records before/after measurements;
- a standalone TypeScript CLI entrypoint;
- a Nest scheduler that runs the same CLI as a child process;
- the shared repository-access lease protocol so maintenance cannot overlap diagnosis or remediation repository use.

The maintenance child acquires `repo-sync.lock`, verifies that `repo-readers` has no live owners, and keeps the exclusive lease through inventory and cleanup. This protects scheduled and manual CLI runs while preserving the diagnosis execution pool introduced on `main`.

The feature must not add cleanup logic to `runner.ts`.

## 5. Inventory and logs

Each run records structured key-value logs for:

- mode: `dry-run` or `execute`;
- trigger: `manual` or `cron`;
- total size of authoritative state JSON files;
- total and per-ecosystem dependency-cache size;
- total and per-repository size;
- temporary worktrees found and their ages;
- active repositories, `.git` size, dependency size, and temporary worktrees;
- planned actions;
- bytes before and after each action;
- bytes reclaimed;
- action duration;
- dependency synchronization duration;
- failures and final status.

Log levels:

- `info`: inventory, no-op, action start/end, and summary;
- `warn`: high limit crossed, coordinated reset required, or abnormal growth;
- `error`: cleanup, rebuild, lock, or child-process failure.

No file contents, credentials, environment values, or repository-local secrets are logged.

## 6. Manual interface

Add:

```bash
npm run storage-maintenance -- --dry-run
npm run storage-maintenance -- --execute
```

`--dry-run` is the default when neither mode is supplied. It performs inventory and planning without mutation.

The first production sequence is:

1. run `--dry-run`;
2. review the plan in Dokku logs;
3. run `--execute` manually;
4. record reclaimed bytes and rebuild duration;
5. configure high and target limits;
6. enable the automatic scheduler.

## 7. Cleanup rules

### 7.1 Incremental cache cleanup

Use each ecosystem's supported cleanup operation against the dedicated cache paths:

- npm cache cleanup/verification;
- pnpm store pruning;
- Go build-cache and module-cache cleanup.

All subprocesses use explicit paths, allowlisted environments, timeouts, stderr capture, and non-zero exit handling.

### 7.2 Worktrees

Remove only temporary worktrees created by the agent that:

- match the agent's known worktree layout;
- are older than the configured minimum age;
- have no live owning process;
- are not referenced by an active run;
- contain no uncommitted changes or unmerged commits.

Unsafe worktrees are logged and skipped.

### 7.3 Repository maintenance

Run `git gc --auto` through the existing Git adapter for every repository discovered by the normal repository scanner. Repository source, branches, remotes, and clone directories are never deleted.

The current application has no independent canonical list of expected clone directories, so automatic removal of whole repositories is outside this delivery. The inventory makes large repositories visible for manual review.

### 7.4 Coordinated reset

A coordinated reset runs only when incremental cleanup leaves the dependency cache above the configured target.

It removes together:

- `state/dependency-cache`;
- `state/dependency-fingerprints.json`;
- npm/pnpm `node_modules` installations managed by dependency sync;
- Go installation markers.

It then calls the existing dependency synchronization logic. A failed rebuild is logged as an error and leaves the next diagnosis able to retry synchronization; it never marks the maintenance as successful.

## 8. Configuration

Add typed configuration under `src/config/` and document it in `.env.example`:

```env
STORAGE_MAINTENANCE_ENABLED=false
STORAGE_MAINTENANCE_CRON=43 3 * * *
STORAGE_DEPENDENCY_CACHE_HIGH_MB=
STORAGE_DEPENDENCY_CACHE_TARGET_MB=
STORAGE_WORKTREE_MIN_AGE_HOURS=24
STORAGE_MAINTENANCE_TIMEOUT_MINUTES=90
```

Rules:

- automatic maintenance requires both cache limits;
- target must be lower than high;
- all sizes and durations must be positive integers;
- invalid enabled configuration fails at boot;
- manual dry-run works without configured thresholds and reports that no threshold decision is available;
- `process.env` is read only in config and CLI entrypoints.

The exact high and target values are chosen after the first manual cleanup.

## 9. Scheduling and concurrency

The Nest scheduler runs daily but performs no action while disabled.

When enabled, the scheduler spawns the maintenance CLI child. Before inventory or mutation, the child acquires the repository synchronization lease and confirms that no diagnosis/remediation reader is active.

If another process owns the synchronization lease or repositories have live readers, automatic maintenance logs the conflict and exits without mutation. Errors are caught and logged; they do not crash Nest or interrupt later pool work.

Shutdown terminates the maintenance child consistently with existing runner-child handling.

## 10. Tests

Required coverage:

- inventory totals and protected-path classification;
- pure plan selection below high, above high, and above target after prune;
- dry-run never mutates;
- incremental actions precede coordinated reset;
- fingerprints and dependent installations reset together;
- protected state, results, secrets, configured repos, and unsafe worktrees are never selected;
- repository source and clone directories are never selected for deletion;
- `git gc --auto` uses the existing Git adapter;
- subprocess timeout and non-zero exit handling;
- dependency rebuild failure reports failure;
- scheduler disabled/enabled behavior and error containment;
- diagnosis/remediation readers and maintenance exclusive access never overlap;
- lease conflict or live readers cause a safe skip;
- configuration validation.

All filesystem and subprocess effects are tested through injected boundaries. Tests do not call registries, GitHub, ClickUp, Google Chat, or Codex.

## 11. Rollout

### Phase 1: calibration

1. deploy with automatic maintenance disabled;
2. run manual dry-run;
3. run one manual execute;
4. verify agent dependency sync and one controlled diagnosis;
5. choose high and target limits from observed post-cleanup size and rebuild cost.

### Phase 2: automation

1. configure limits and cron;
2. enable maintenance;
3. inspect the first automatic run in Dokku logs;
4. keep rollback as `STORAGE_MAINTENANCE_ENABLED=false`.

No state migration is required.

## 12. Success criteria

- Storage consumption is visible by category in Dokku logs.
- Manual dry-run accurately describes every planned deletion.
- The first manual cleanup reports reclaimed space and rebuild cost.
- Automatic maintenance never overlaps diagnosis or remediation.
- Protected paths and configured repository source are preserved.
- Incremental cleanup runs before any coordinated reset.
- A coordinated reset leaves dependency synchronization able to rebuild or retry safely.
- Automatic maintenance can be disabled with one configuration change.
- `npm run build`, `npm run lint`, and `npm test` pass.
