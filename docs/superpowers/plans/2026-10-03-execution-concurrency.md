# Execution Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Track every task with tests and a focused commit.

## Context

The Nest process currently serializes diagnoses and remediation reorientations through one in-memory promise queue, while the runner holds one global `state/diagnosis.lock`. A long cron batch therefore blocks an unrelated manual diagnosis or Grafana incident. During a Dokku restart, the old and new containers overlap on the same state volume, but ownership is represented only by a PID or process-local promise, so locks and `running` records can become orphaned and active work is not resumed.

The approved design replaces that bottleneck with bounded concurrency while keeping the runner as an isolated child process. It introduces leased ownership across containers, cross-process-safe JSON updates, repository reader coordination, per-item claims, durable heartbeats, graceful interruption, and bounded automatic recovery. A resumed item reuses completed diagnosis artifacts and reruns only remediation when possible.

**Goal:** Allow unrelated diagnoses and reorientations to run concurrently, and recover interrupted work automatically without duplicate diagnosis, remediation, PRs, ClickUp comments, or Chat cards.

**Architecture:** Build safety primitives first, then repository/item coordination, then the Nest execution pool, then durable lifecycle/recovery, and only then enable artifact-based resume. The runner remains a child process; Nest owns queueing and durable run records; shared TypeScript helpers provide lock, lease, and JSON semantics to both processes.

**Tech stack:** Node.js 24, NestJS 11, strict TypeScript/NodeNext, Vitest, filesystem JSON state, `child_process`, git/gh/Codex adapters.

**Spec:** `docs/superpowers/specs/2026-09-29-execution-concurrency-design.md` at commit `bafadad`

## Global Constraints

- Keep `src/runner.ts` as a child-process entrypoint; never move it into Nest.
- Preserve the public contracts of `DiagnosisExecutionService.enqueue` and `enqueueReorientation`.
- Default `DIAGNOSIS_EXECUTION_CONCURRENCY` to `2`; accept only integers `>= 1`; value `1` is the operational rollback.
- Use owner identity `<hostname>:<uuid>` in Nest and `runner:<hostname>:<uuid>` for a manual runner. Do not use PID liveness.
- Use a 30-second heartbeat, 2-minute lease, and 30-second JSON-lock wait timeout.
- Keep one cron batch in flight and retain `RUNNER_CONCURRENCY` unchanged.
- Keep all existing JSON state formats readable; every new field is additive.
- Use typed IPC from `src/diagnosis/runner-messages.ts`; never parse stdout for lifecycle events.
- Keep `process.env` reads inside `src/config/` and entrypoints only.
- Preserve adapter boundaries and mock external ClickUp, GitHub, Google Chat, Grafana, Codex, and remote git operations in tests.
- Do not push, merge, deploy, or run Dokku rollout validation without an explicit later request.

## Review Focus

1. **Overlapping containers with the same PID:** distinct `instanceId` values must keep live owners separate; tests belong to Tasks 1 and 3.
2. **Process death between persisting resumed records and inserting them into the in-memory pool:** persisted `queued` records must be recoverable without creating a second resume generation; tests belong to Task 7.
3. **Two requests for the same ticket while another item is queued:** the same key must serialize while the next eligible different key starts; tests belong to Task 5.
4. **Restart after diagnosis notification but before remediation completes:** diagnosis Codex must not run again and notification/comment/PR side effects must remain idempotent; tests belong to Tasks 8 and 9.
5. **A cron ticket selected before another process marks it complete:** claim acquisition must be followed by a fresh `processed.json` read so the second worker skips it; tests belong to Task 4.

---

## Task 1: Shared owner identity and leased filesystem lock

**Files:**

- Create: `src/state/owner-identity.ts`
- Test: `src/state/owner-identity.spec.ts`
- Create: `src/state/owned-lock.ts`
- Test: `src/state/owned-lock.spec.ts`

**Interfaces:**

- `createInstanceId(prefix?: 'runner'): string`
- `OwnedLockOwner = { instanceId: string; pid: number; startedAt: string; heartbeatAt: string }`
- `acquireOwnedLock(options): Promise<OwnedLockHandle>` where the handle exposes `owner`, a unique fencing `token`, `heartbeat()`, and `release()`.
- Options include `directory`, `owner`, `leaseMs`, `waitTimeoutMs`, `pollIntervalMs`, `now`, and `sleep` so tests use deterministic clocks without real waits.

- [ ] Write failing owner tests proving Nest IDs match `<hostname>:<uuid>`, manual IDs match `runner:<hostname>:<uuid>`, and repeated calls are distinct.
- [ ] Implement `createInstanceId` with `hostname()` and `randomUUID()`; do not read environment variables.
- [ ] Write failing lock tests for acquire/release, mode `0600` on `owner.json`, heartbeat renewal, live-owner waiting/timeout, expired-owner rename to `<name>.stale-<timestamp>`, unreadable/missing owner fallback to directory mtime, equal PIDs with distinct instance IDs, and a delayed old release that must not delete a replacement owner.
- [ ] Implement directory acquisition with `mkdir`, atomic owner JSON writes through `writeJsonAtomic`, polling for live owners, and stale-directory audit rename. Persist and compare a per-acquisition fencing token so heartbeat/release only mutate or remove the exact acquisition that created the handle.
- [ ] Run `npm test -- src/state/owner-identity.spec.ts src/state/owned-lock.spec.ts` and confirm all cases pass.
- [ ] Commit only these four files as `feat: add leased filesystem ownership`.

## Task 2: Cross-process JSON updates and processed-state merge

**Files:**

- Create: `src/state/locked-json-update.ts`
- Test: `src/state/locked-json-update.spec.ts`
- Modify: `src/state/state.service.ts`
- Create: `src/state/state.service.spec.ts`
- Modify: `src/diagnosis/ticket-processing.ts`
- Modify/Test: `src/diagnosis/ticket-processing.spec.ts` or the nearest existing public-behavior suite that invokes processed persistence.

**Interfaces:**

- `updateJsonFileLocked<T extends Record<string, unknown>>(filename, owner, mutate, options?): Promise<T>`.
- The mutator may be synchronous or async, receives a freshly read object, and writes only after it succeeds.
- `markProcessed(ticket, processedAt, owner): Promise<void>` performs a locked read/merge/write of one version key; callers no longer pass a mutable process-wide snapshot.

- [ ] Write failing tests proving missing files start as `{}`, concurrent updates from two owner identities preserve both entries, a mutator failure writes nothing, live-lock timeout surfaces an error, and separate files do not share a lock.
- [ ] Implement `updateJsonFileLocked` using `<filename>.lock`, `acquireOwnedLock`, fresh JSON parsing inside the lock, and `writeJsonAtomic`.
- [ ] Change `StateService` to keep its in-process queue but delegate each read-modify-write to `updateJsonFileLocked`; inject/create one stable Nest instance owner rather than generating an owner per update.
- [ ] Add `StateService` tests with two service instances sharing one temporary directory and verify both mutations survive.
- [ ] Replace `stateWriteQueue` and snapshot writes in `ticket-processing.ts` with the locked merge; preserve the exact `processed.json` object shape and version key `${id}:${updated_at}`.
- [ ] Run `npm test -- src/state/locked-json-update.spec.ts src/state/state.service.spec.ts src/diagnosis/ticket-processing.spec.ts`.
- [ ] Commit as `feat: serialize JSON updates across processes`.

## Task 3: Repository access protocol and item claims

**Files:**

- Create: `src/git/repository-access.ts`
- Test: `src/git/repository-access.spec.ts`
- Create: `src/diagnosis/item-claims.ts`
- Test: `src/diagnosis/item-claims.spec.ts`
- Delete after migration: `src/runner/runner-lock.ts`
- Delete/update test: any `runner-lock` test or import.

**Interfaces:**

- `RepositorySyncInfo = { status: 'synced' | 'skipped'; heads: Record<string, string> }`.
- `withRepositoryAccess(config, { owner, syncOnly }, fn): Promise<void>` acquires `state/repo-sync.lock`, prunes expired readers, syncs only with no live readers, creates a reader while still under the sync lock, then invokes `fn(syncInfo)` and releases the reader in `finally`.
- `withItemClaim({ key, owner, batch }, fn): Promise<'processed' | 'skipped'>`; a live duplicate returns `skipped` only for a batch and throws for a single-item execution.
- `itemKey({ ticketId?, incidentId?, reorientationTicketId? }): string | undefined` centralizes `ticket:<id>` and `incident:<id>` formatting for Nest and runner.
- Claim directory names use a sanitized readable prefix plus a short SHA-256 suffix of the raw key so distinct punctuation-heavy IDs cannot collide after sanitization.

- [ ] Write failing repository-access tests for sync with no readers, skip with a live reader plus recorded HEADs, expired reader cleanup, expired sync-lock takeover, sync timeout, and `syncOnly` failure when readers are live.
- [ ] Implement dependency-injected repository callbacks around existing `synchronizeRepositories`, `syncDependencies`, `materializeDiagnosisEnvFiles`, and a focused helper that reads repository HEADs.
- [ ] Write failing claim tests for acquire/release, sanitized directory names, live duplicate behavior in batch versus single mode, expired-owner takeover, and same-PID/different-instance behavior.
- [ ] Implement item claims as `state/item-locks/<sanitized-key>` backed by `owned-lock`.
- [ ] Run `npm test -- src/git/repository-access.spec.ts src/diagnosis/item-claims.spec.ts`.
- [ ] Commit as `feat: coordinate repository readers and item claims`.

## Task 4: Runner ownership, repository access, claims, and fresh eligibility

**Files:**

- Modify: `src/runner/runner-args.ts`
- Modify/Test: `src/runner/runner-args.spec.ts`
- Modify: `src/runner.ts`
- Modify: `src/diagnosis/ticket-processing.ts`
- Modify: `src/incidents/incident-processing.ts`
- Modify: `src/remediation/remediation-reorientation-run.ts`
- Modify/Test: `src/incidents/runner-integration.spec.ts`
- Create focused runner orchestration tests if the integration suite cannot assert the behavior without spawning real processes.

**Interfaces:**

- Add `ownerInstanceId?: string`, `resume: boolean`, and existing item IDs to `RunnerArgs`; parse `--owner-instance-id=<id>` and `--resume`.
- `withRepositoryAccess` wraps all incident, reorientation, sync-only, and ticket paths.
- Each item is wrapped in `withItemClaim`; the cron path emits `item-started` only after claim acquisition and `item-finished` in `finally`.
- `processTicket` and `processIncident` receive `RepositorySyncInfo` and persist it as additive `repository_sync` in `run.json`.

- [ ] Add parser tests for valid owner/resume arguments, empty owner rejection, and help text.
- [ ] Add runner tests proving the four duplicated global-lock blocks become repository-access calls, sync-only fails with readers, and `repository_sync` is persisted for both `synced` and `skipped` executions.
- [ ] Add a cron-batch test where a live claim skips one ticket without increasing failures and another ticket still runs.
- [ ] Add the stale-selection test: after claim acquisition, reread `processed.json`; skip an already processed version unless `force` is true.
- [ ] Generate an ephemeral `runner:` owner when `--owner-instance-id` is absent, pass the owner to repository access, claims, and locked processed-state writes, and remove every `acquireDiagnosisLock` call/import.
- [ ] Keep per-ticket errors isolated in the cron batch and ensure claim/repository-reader cleanup occurs in `finally`.
- [ ] Run `npm test -- src/runner/runner-args.spec.ts src/incidents/runner-integration.spec.ts src/diagnosis/ticket-processing.spec.ts` and the new runner orchestration suite.
- [ ] Commit as `refactor: coordinate runner access per item`.

## Task 5: Configurable FIFO execution pool with key exclusion

**Files:**

- Create: `src/diagnosis/execution-pool.ts`
- Test: `src/diagnosis/execution-pool.spec.ts`
- Modify: `src/config/app-config.ts`
- Modify/Test: `src/config/app-config.spec.ts`
- Modify: `src/diagnosis/diagnosis-execution.service.ts`
- Modify/Test: `src/diagnosis/diagnosis-execution.service.spec.ts`

**Interfaces:**

- `ExecutionPool.enqueue<T>({ key, run }): Promise<T>` with fixed concurrency, FIFO scanning, active-key exclusion, and `stopStarting()` for shutdown.
- Queue selection starts the earliest eligible entry; if its key is active, the pool may start the next different key and returns to the skipped entry when the key is released.
- `AppConfig.diagnosisExecutionConcurrency: number` comes from `DIAGNOSIS_EXECUTION_CONCURRENCY`, default `2`.

- [ ] Write pool tests for limit `N`, FIFO, same-key serialization, a different key passing a blocked entry, keyless cron eligibility, reorientation sharing capacity, thrown/rejected work releasing a slot, and `stopStarting()` leaving queued work untouched.
- [ ] Implement the pool as a focused pure coordination class with no Nest or filesystem dependency.
- [ ] Add config tests for default `2`, accepted `1`, accepted larger positive integers, and boot failure for `0`, negative, decimal, and nonnumeric values.
- [ ] Replace `DiagnosisExecutionService.queue` with the pool while keeping `{ runId, completion }` and reorientation promise contracts unchanged. Derive keys with the shared item-key helper.
- [ ] Preserve `queued` until a pool slot is acquired, patch `running` immediately before spawn, and release in `finally` on spawn error, nonzero exit, notification failure, or success.
- [ ] Keep `DiagnosisScheduler.inFlight` unchanged and rerun its existing suite.
- [ ] Run `npm test -- src/diagnosis/execution-pool.spec.ts src/config/app-config.spec.ts src/diagnosis/diagnosis-execution.service.spec.ts src/diagnosis/diagnosis.scheduler.spec.ts`.
- [ ] Commit as `feat: run diagnoses in a keyed execution pool`.

## Task 6: Durable execution lifecycle, heartbeat, IPC active items, and shutdown

**Files:**

- Modify: `src/diagnosis/diagnosis-run.ts`
- Modify/Test: `src/diagnosis/diagnosis-output.spec.ts` or direct status tests.
- Modify: `src/diagnosis/runner-messages.ts`
- Modify/Test: corresponding IPC tests in `src/diagnosis/diagnosis-execution.service.spec.ts`.
- Create: `src/diagnosis/execution-heartbeat.ts`
- Test: `src/diagnosis/execution-heartbeat.spec.ts`
- Modify: `src/diagnosis/diagnosis-execution.service.ts`

**Interfaces:**

- Add `'interrupted'` to `RUN_STATUSES`; keep it out of `ACTIVE_RUN_STATUSES`.
- Extend diagnosis and reorientation records additively with `ownerInstanceId`, `heartbeatAt`, `activeItems`, `resumedFrom`, `resumedBy`, and `resumeAttempt` as applicable.
- Add typed `item-started` and `item-finished` messages with `{ key: string }`.
- `ExecutionHeartbeat.start()/stop()` batches updates of this instance's running diagnosis/reorientation records every 30 seconds.
- `DiagnosisExecutionService` implements `OnApplicationShutdown`, tracks child processes by run ID, stops new starts, sends `SIGTERM`, and atomically marks its own running records `interrupted` with `finishedAt` and `error: 'interrupted by shutdown'`.

- [ ] Add status/IPC validation tests, including malformed lifecycle messages and backward-compatible old records.
- [ ] Write heartbeat tests proving only this instance's `running` records update, one state update covers all owned records, queued/terminal/other-instance records are untouched, and `stop()` clears the timer.
- [ ] Pass `--owner-instance-id` to every child runner, record ownership/start heartbeat on transition to `running`, and update `activeItems` idempotently from lifecycle IPC.
- [ ] Add shutdown tests with fake children proving the pool stops starting new entries, every active child receives `SIGTERM`, all owned running records become `interrupted`, queued records remain queued for recovery, and shutdown does not wait for child exit.
- [ ] Ensure normal child completion cannot overwrite a record already marked `interrupted` by shutdown.
- [ ] Run `npm test -- src/diagnosis/execution-heartbeat.spec.ts src/diagnosis/diagnosis-execution.service.spec.ts`.
- [ ] Commit as `feat: track execution ownership and shutdown`.

## Task 7: Pure recovery decision and atomic recovery service

**Files:**

- Create: `src/diagnosis/run-recovery.ts`
- Test: `src/diagnosis/run-recovery.spec.ts`
- Create: `src/diagnosis/run-recovery.service.ts`
- Test: `src/diagnosis/run-recovery.service.spec.ts`
- Modify: `src/diagnosis/diagnosis.module.ts`
- Modify: `src/diagnosis/diagnosis-execution.service.ts` to accept already-persisted records without creating duplicates.

**Interfaces:**

- `planRunRecovery(runs, reorientations, instanceId, now, leaseMs): RecoveryPlan` is pure.
- `RecoveryPlan` contains exact diagnosis/reorientation transitions and resume descriptors; old records fall back from missing `heartbeatAt` to `startedAt`.
- `RunRecoveryService` runs on module initialization and `@Interval(60_000)`, with try/catch logging.
- `DiagnosisExecutionService.schedulePersistedDiagnosis(record)` and `schedulePersistedReorientation(record)` add an existing `queued` record to the pool without rewriting it.
- Diagnosis attempts remain in `diagnosis-runs.json`. Reorientation recovery updates only `remediation-reorientations.json` and requeues the same request ID; it does not require a cross-file transaction. Each file's transition and retry metadata is atomic within that file, and a crash between the independent scans is safe because the next interval retries the untouched file.

- [ ] Write pure tests covering expired other-instance running records, live overlap, own-instance records, lost queued records, shutdown-interrupted records, absent `resumedBy`, `resumedBy: []`, single item, cron `activeItems` only, reorientation, old records without new fields, and `resumeAttempt >= 2`.
- [ ] Implement recovery descriptors that preserve source, force/resume semantics, notification/remediation settings, Chat space/thread, and reorientation identity.
- [ ] Write service tests proving diagnosis interruption, creation of all resumed `queued` records, and original `resumedBy` are committed in one `diagnosis-runs.json` update before scheduling occurs; add the equivalent single-file transition test for a reorientation request.
- [ ] Add the crash-window test: make scheduling throw after persistence; the next sweep treats persisted queued children as recoverable without adding another child to the original record.
- [ ] Allocate run IDs in the service, persist `resumedFrom` and `resumeAttempt + 1`, write `resumedBy` even when empty, then schedule only after the state update resolves.
- [ ] Log and do not enqueue when the attempt limit is reached; keep the record `interrupted`.
- [ ] Register the service once in `DiagnosisModule`; avoid circular providers by passing scheduling methods through `DiagnosisExecutionService` rather than importing Chat services into recovery logic.
- [ ] Run `npm test -- src/diagnosis/run-recovery.spec.ts src/diagnosis/run-recovery.service.spec.ts src/diagnosis/diagnosis-execution.service.spec.ts`.
- [ ] Commit as `feat: recover interrupted diagnosis runs`.

## Task 8: Resume checkpoints for tickets and incidents

**Files:**

- Create: `src/diagnosis/resume-checkpoint.ts`
- Test: `src/diagnosis/resume-checkpoint.spec.ts`
- Modify: `src/diagnosis/ticket-processing.ts`
- Modify/Test: `src/diagnosis/ticket-processing.spec.ts`
- Modify: `src/incidents/incident-processing.ts`
- Modify/Test: `src/incidents/runner-integration.spec.ts`
- Modify: `src/runner.ts`

**Interfaces:**

- `readResumeCheckpoint(ticketDir): Promise<'diagnosis-complete' | 'restart'>` recognizes the current real checkpoint: `run.json.status === 'diagnosed'`, `remediation_status === 'pending'`, and a valid `engineering-action.json`. The spec's impossible `status: success` + `pending` combination is corrected here rather than changing established artifact semantics.
- Extract `remediateTicketFromArtifacts(...)` and export `remediateIncidentFromArtifacts(...)` so a resume can reuse persisted `ticket.json`, `engineering-action.json`, issue data, repository selection inputs, and diagnosis metadata.
- Resume with an incomplete checkpoint calls the normal item path with `force: true`.

- [ ] Write checkpoint tests for missing/corrupt files, any status other than `diagnosed`, absent engineering action, non-pending remediation, and a valid completed diagnosis checkpoint.
- [ ] Add ticket tests proving a valid checkpoint does not call `runCodex`, reconstructs/sends the diagnosis-ready IPC message, runs only remediation, writes `remediation.json`, updates `run.json`, and marks processed once.
- [ ] Add incident tests proving a valid checkpoint does not call diagnosis Codex or recreate issues, resends the diagnosis card through the existing ack protocol, runs only remediation, and writes final artifacts.
- [ ] Add restart-path tests proving incomplete checkpoints execute from the beginning with `force`, so ClickUp creation-window and processed filters do not discard the item.
- [ ] Keep notification delivery on existing IPC and existing notification dedup keys; do not call Google Chat directly from the runner.
- [ ] Treat reorientation resume as a full rerun of the same request and rely on the reorientation record/pool key for serialization.
- [ ] Run `npm test -- src/diagnosis/resume-checkpoint.spec.ts src/diagnosis/ticket-processing.spec.ts src/incidents/runner-integration.spec.ts src/remediation/remediation-reorientation.spec.ts`.
- [ ] Commit as `feat: resume remediation from diagnosis artifacts`.

## Task 9: Remediation restart idempotency

**Files:**

- Modify: `src/git/worktrees.ts`
- Create/Modify Test: `src/git/worktrees.spec.ts`
- Modify: `src/remediation/remediation-run.ts`
- Modify/Test: the focused remediation-run suite.
- Modify: `src/remediation/ticket-remediation.ts`
- Modify/Test: `src/remediation/ticket-remediation.spec.ts`
- Modify: GitHub adapter tests only where deterministic branch reuse needs a new adapter operation.
- Modify: `src/google-chat/google-chat-messenger.service.ts`
- Modify: `src/google-chat/google-chat-threading.ts`
- Modify/Test: `src/google-chat/google-chat-notifications.service.spec.ts`
- Modify: `src/google-chat/google-chat-actions.service.ts`
- Modify/Test: `src/google-chat/google-chat-actions.service.spec.ts`

**Interfaces:**

- `prepareRemediationWorktrees(ticketId, repositories): Promise<string>` prunes registered git worktrees and removes orphaned temp directories for the same sanitized item before creating the new directory.
- A single deterministic branch-name helper derives the branch from item/cause and is shared by initial and resumed remediation prompts/operations. Reorientation keeps its existing replacement-branch semantics; only retry of the same attempt/cause reuses a branch.
- Existing remote branch behavior is explicit: reuse and force-push the deterministic branch; existing open PR behavior continues through current PR dedup.
- `GoogleChatMessengerService.sendMessage` accepts a stable `requestId` derived from the notification key and forwards it to `spaces.messages.create`; retrying the same notification returns the existing message instead of creating another.
- ClickUp comment approval embeds or records a stable marker derived from approval ID/comment hash and checks existing task comments for that marker before posting, closing the remote-success/local-state-crash window.

- [ ] Add worktree tests for orphan directory cleanup and adapter-level `git worktree prune` invocation without touching unrelated item directories.
- [ ] Add branch tests proving initial and resumed attempts produce the same name, an existing remote branch is reused rather than rejected, and a new branch is not invented.
- [ ] Retain and extend current open-PR reuse tests in `ticket-remediation.spec.ts`; add incident coverage if the adapter path differs.
- [ ] Add Google Chat request-construction tests proving a stable notification key produces the same API `requestId`, retries reuse the existing remote message, and unrelated notification keys remain distinct.
- [ ] Add ClickUp action tests for the crash boundary where the remote comment exists but `clickupCommentId` was not persisted; marker reconciliation must recover the existing comment instead of posting again.
- [ ] Add side-effect tests proving resumed execution does not duplicate the ClickUp comment, diagnosis card, remediation card, or already open PR.
- [ ] Implement the smallest adapter/prompt changes needed for deterministic branch reuse; keep `GH_TOKEN` restricted to remediation.
- [ ] Run remediation, GitHub adapter, notification, and ClickUp suites together.
- [ ] Commit as `fix: make resumed remediation idempotent`.

## Task 10: Operational documentation, compatibility, and complete verification

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: any state/run type fixtures that explicitly enumerate statuses or fields.
- Add no migration that deletes `state/diagnosis.lock`; document it as inert and removable.

**Interfaces:**

- Document `DIAGNOSIS_EXECUTION_CONCURRENCY=2`, rollback value `1`, and interaction with unchanged `RUNNER_CONCURRENCY`.
- Document repository-sync skip semantics and additive `repository_sync` artifact field.
- Document automatic recovery, maximum two resume attempts, and that stale lease directories are retained as `.stale-*` audit evidence.

- [ ] Add `.env.example` with a short operational comment and update README configuration/architecture/rollout sections.
- [ ] Add compatibility tests/fixtures showing old diagnosis and reorientation records without owner/recovery fields still parse and recover using `startedAt`.
- [ ] Run focused regression suites for scheduler, controller, Chat reorientation, incidents, ticket processing, remediation, state, and config.
- [ ] Run `npm run build` and fix every strict TypeScript/NodeNext error without `any`, unsafe non-null assertions, or duplicated literal unions.
- [ ] Run `npm run lint` with zero warnings.
- [ ] Run `npm test` and record the final test count/output.
- [ ] Run `git diff --check` and inspect `git status --short` to ensure pre-existing untracked `.playwright-mcp/`, `presentation/`, `repos/`, and fixture files were not staged or modified.
- [ ] Request an independent code review of the whole branch. Address confirmed findings with focused tests and rerun build, lint, and test.
- [ ] Commit documentation/compatibility changes as `docs: document concurrent diagnosis execution` and keep the branch local unless the user explicitly requests push/PR.

## Execution Order and Gates

After approval, switch from `feat/github-app-auth` to `feat/execution-concurrency`, verify tracked state is clean, and save the canonical plan copy as `docs/superpowers/plans/2026-10-03-execution-concurrency.md` before product-code edits.

1. Tasks 1-2 establish shared safety and can be reviewed independently.
2. Tasks 3-4 remove the global runner lock only after leased locks and JSON updates are proven.
3. Task 5 enables concurrency only after runner-side repository and item exclusion exists.
4. Tasks 6-7 make active work durable and recoverable before resume execution is enabled.
5. Tasks 8-9 activate checkpoint reuse and verify every external side effect is idempotent.
6. Task 10 closes config, compatibility, docs, and whole-branch verification.

No later task may weaken an earlier gate. In particular, do not merge Task 5 without Tasks 1-4, and do not schedule recovered work from Task 7 until Tasks 8-9 are complete on the branch.

## Verification

Targeted Vitest commands run after each task. Final evidence must include:

```bash
npm run build
npm run lint
npm test
git diff --check
git status --short
```

The production rollout checks from the spec remain manual and out of scope until explicitly authorized: verify a manual diagnosis becomes `running` during cron with `repository_sync.status = 'skipped'`; then restart during an incident and confirm the old run becomes `interrupted`, a new run has `resumedFrom`, locks clear within the lease window, and cards/PRs are not duplicated. Rollback is `DIAGNOSIS_EXECUTION_CONCURRENCY=1`.

## Reference

- [Google Chat `spaces.messages.create`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create) documents stable `requestId` retries and client-assigned message IDs used by Task 9.
