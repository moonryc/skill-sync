## Context

The CLI already separates domain, application, infrastructure, command, and UI code and has strong
exact-revision, validation, redaction, and same-filesystem replacement primitives. The audit exposed
four classes of cross-cutting risk:

1. recovery metadata is stored beneath per-scope directories but startup discovery is top-level,
   and current journals do not durably describe every rename boundary;
2. cancellation and per-skill error handling can report a result that does not match committed or
   incompletely restored state;
3. command capabilities and public documentation are duplicated across parser, handlers, README,
   bundled skill, and wiki;
4. human review and multi-library workflows have outgrown the current raw-object rendering and
   single-user-default configuration.

The working tree also contains the completed `add-cli-update-and-version-check` implementation and
an in-progress `release-on-main-merge` change. This design hardens and integrates those changes. It
does not create another updater or release pipeline.

## Goals / Non-Goals

**Goals:**

- Make interruption, rollback, recovery, and cross-process coordination conservative and
  deterministic.
- Ensure every human, JSON, dry-run, offline, and TUI result describes the durable state that
  actually exists.
- Make content review strong enough to authorize publish, discard, uninstall, deletion, or
  recovery.
- Consolidate command and managed-scope contracts while preserving the existing domain safety
  boundaries.
- Support multiple named and project-declared credential-free libraries.
- Add measurable packaged, cross-platform, performance, and documentation quality gates.
- Deliver the work as one OpenSpec change with implementation phases that can be reviewed and
  committed independently.

**Non-Goals:**

- Automatically merge conflicting skill content.
- Store Git, npm, GitHub, SSH, or registry credentials.
- Execute repository scripts, diff drivers, hooks, text converters, submodules, or skill content.
- Add remote analytics or usage telemetry.
- Replace Git as the canonical library history and authentication transport.
- Make old ambiguous journals auto-recoverable when the required evidence was never persisted.
- Support arbitrary third-party runtime plugins in this change; target and scope registries become
  extensible, but new agents can be added separately.

## Decisions

### 1. Deliver one change through ordered safety gates

Implementation will proceed in phases: baseline and current updater corrections; durable recovery;
execution and state safety; typed command contracts; review and human workflows; profiles; then
quality, performance, and release gates. Later phases cannot land until the applicable P0
fault-injection and packaged tests pass.

This keeps one coordinated public plan without creating a single unreviewable code commit.
Alternatives considered were separate OpenSpec changes per finding or implementing UX first. The
first would duplicate migrations and command metadata; the second would build new workflows on
unreliable recovery semantics.

### 2. Introduce a versioned transaction journal with deterministic paths

Journal schema v2 will persist:

- operation and scope identifiers plus a fingerprint of the normalized transaction root;
- exact relative destination, candidate, and rollback paths;
- action, expected source/staged digest, original digest when present, and final intended digest;
- per-entry `pending`, `prepared`, `original-moved`, `committed`, or `restored` state;
- transaction status, timestamps, and redacted diagnostic notes.

Candidate and rollback paths will be deterministic from the journaled operation ID and entry index.
The complete plan is written and fsynced before preparation. Each original move and candidate commit
is followed by a journal update using the existing atomic, fsynced JSON writer. Terminal status is
written before cleanup.

Existing v1 journals remain readable for discovery but are inspect-only because they lack exact
hidden paths and transition evidence. The CLI will never infer those paths from a directory scan.

### 3. Add a conservative recovery service and commands

Recovery discovery will walk only the known lock, journal, backup, and staging roots, validate every
entry with `lstat`/`realpath`, and never follow symbolic links. A recovery record receives a stable
display ID derived from its scope and operation ID.

`recovery resume` completes the intended new state only when every committed destination and
remaining candidate matches the journal. `recovery restore` returns to the old state only when every
rollback and destination matches. Both use the normal planner, dry-run, lock, digest recheck,
confirmation, and journal mechanisms. Ambiguity blocks action. `recovery prune` operates only on
explicitly selected terminal records and proven-owned paths.

An alternative was startup auto-replay. It was rejected because a user must choose whether an
interrupted destructive operation should finish or be reversed.

### 4. Model command execution with a commit-aware operation guard

The runtime boundary will expose an `OperationGuard` containing the shared `AbortSignal`,
`throwIfCancelled`, recovery registration, and a commit barrier. Cancellation may abort preparation
and child processes. Once an atomic transaction enters committing, cancellation is deferred until
the transaction proves committed or rolled back. A committed transaction returns success with a
post-commit interruption warning; a proven rollback may return cancellation; an ambiguous result
returns recovery-required.

Process, cache, hashing, staging, and planner ports receive the same signal. This replaces sparse
top-level checkpoints and prevents a late signal from overwriting a committed result.

### 5. Use an explicit fatal error taxonomy

Application services will distinguish:

- input/configuration/repository errors before mutation;
- per-skill errors whose rollback was durably proven;
- cancellation with no commit;
- recovery-required errors caused by failed rollback, journal persistence, lock ownership, or
  ambiguous state.

Only proven-rolled-back per-skill failures may participate in the existing deterministic partial
batch policy. Recovery-required errors immediately stop later skills and keep the scope blocked.

### 6. Share state-pair and managed-scope contracts

A single state-pair loader will validate project and global manifest/lock schema, identity, exact ID
sets, projections, containment, and uniqueness. A `ManagedScopeAdapter` will provide root,
manifest/lock paths, destination resolution, transaction storage, and human scope labels.

Project and global application services will call shared install, inspect, reconcile, uninstall,
recovery, and migration orchestration with scope adapters. Scope-specific behavior remains in target
destination and state storage adapters. This replaces parallel validation paths and makes the
currently unused scope descriptor authoritative.

### 7. Replace process-local coordination with filesystem locks

Cache refresh, exact-snapshot publication, canonical library mutation, project/global mutation,
profile migration, and recovery will use the existing advisory-lock format through a shared lock
service. Lock keys are derived from normalized library identity or managed scope. Process-local
deduplication may remain as an optimization but is not the correctness boundary.

Locks are never silently stolen. Stale or malformed metadata is reported through `doctor` and
recovery guidance, with an explicit narrowly targeted remediation operation.

### 8. Centralize subprocess and resource policy

One `ProcessRunner` will own argument-array execution, sanitized environment, redaction, timeout,
output limits, cancellation, Windows executable resolution, and interactive policy. Git content
mode continues to disable hooks, filters, submodules, external diff, and global/system content
configuration. JSON and `--no-input` set Git/SSH/GitHub/npm noninteractive behavior.

A central `ResourceBudget` applies to file size, total bytes, file count, depth, output, and bounded
I/O concurrency. Hashing will stream file content into per-file and tree digests rather than retain
all buffers. Initial defaults will be chosen from repository fixtures and documented before the
limits become blocking; configuration may lower them or raise them only to compiled safety ceilings.

### 9. Build the CLI from a typed command registry

Each `CommandDefinition` will declare name and parent, arguments, typed choices, local and inherited
options, supported scopes, mutation class, interactivity, freshness, result schema identifier,
human renderer, handler, examples, safety notes, documentation link, and completion provider.

Commander registration, dispatch, parser-error attribution, JSON command names, help, and a
generated wiki catalog module come from this registry. Command-specific handlers receive parsed
types rather than `unknown[]` and string-keyed option records. README, bundled skill, and long-form
wiki prose remain authored, but parity tests verify that every public command and option is covered.

The JSON envelope remains versioned independently from durable state schemas. Command data schemas
are named and inventoried so one command can evolve without conflating its version with manifest or
cache versions.

### 10. Make previews use disposable revision resolution

Revision resolution will distinguish persistent refresh, verified persistent inspection, and
disposable fetch. Dry-run uses a disposable exact snapshot when it needs the network and deletes it
before exit; it never updates persistent cache metadata. Offline behavior is registry-scoped:
`status` and `doctor` can explicitly skip network access, while `sync` and `update` require a full
cached revision. `list`, `info`, and `diff` reject an explicit offline option but visibly label a
verified stale fallback and direct the user to retry when remote access is available. A future
`--refresh` capability, where declared, forces persistent remote refresh and conflicts with offline
mode.

Every plan carries library identity, revision, freshness, scope, local digests, planned writes,
backup requirements, and a deterministic plan fingerprint. Apply re-resolves and revalidates under
lock; a changed fingerprint requires a new review.

### 11. Use a built-in bounded inert diff engine

The diff service will materialize verified local, recorded-base, and canonical inventories and read
text only within resource budgets. A bounded line-oriented diff implementation will generate
unified hunks without invoking external diff tools or repository configuration. NUL-containing,
invalid-text, binary, unreadable, or over-limit files use metadata summaries.

Human mode defaults to bounded patch review. `--stat` and `--name-only` provide compact modes.
Structured output contains change metadata by default and hunks only when explicitly requested.
Multiple skills share one resolved revision and are ordered deterministically.

Using `git diff --no-index` was rejected because keeping attributes, external drivers, pagers, and
platform behavior provably inert would complicate the existing content boundary.

### 12. Separate structured results, human rendering, and progress events

Application services always return typed structured results. Command definitions select
command-specific human renderers; generic object pretty-printing is removed from normal human mode.
A progress event sink receives redacted phase events. The TTY renderer owns spinners and clearing;
JSON, quiet, non-TTY, completion, and tests receive a no-op sink.

The TUI calls the same planners and render models as argument-driven commands. First-run states
offer init/create/doctor. Confirmation applies a plan only after revalidation; if its fingerprint
changes, the TUI returns to review. Target and gitignore policy come from effective configuration,
not hard-coded values.

### 13. Add static and local-only dynamic completion

`completion --shell bash|zsh|fish|powershell` renders deterministic scripts from the command
registry. A hidden completion protocol may return cached skill IDs, profiles, targets, groups, and
states, but it runs with network, prompts, mutation, progress, and passive update checks disabled and
has a short deadline. Package-manager installation remains documented rather than modifying shell
profiles automatically.

### 14. Migrate configuration to profiles and project connections

User configuration schema v2 stores named profiles plus a selected default. Legacy single-library
configuration is read as an implicit default and migrates atomically only on write. Project manifest
schema v2 may include a credential-free normalized remote and branch beside identity; old
identity-only manifests remain valid.

Resolution precedence is command, environment, project connection, selected user profile, legacy
default, then unconfigured. Existing managed state always constrains the resolved identity. A
different override cannot retarget installed skills without a future explicit migration workflow.

### 15. Make quality gates proportional and artifact-focused

A hermetic local bare remote will drive packaged tarball lifecycle tests on supported operating
systems. Fault-injection child processes will stop transactions at every rename boundary.
Cross-process tests will cover cache and library locks. Coverage starts report-only, then ratchets
per layer; performance tests count Git calls and measure time, memory, and file descriptors for
representative libraries.

The staged package allowlist and size/file-count budgets will remove declarations and maps unless a
documented consumer requires them. The update adapter will use a Windows-safe npm entrypoint or
platform-resolved executable without accepting shell interpolation. Passive registry checks use a
bounded TTL cache and opt-out and are documented as network access, not telemetry.

## Risks / Trade-offs

- **[Risk] The change is broad and could become difficult to review.** → Deliver the ordered phases
  as focused commits with phase-specific tests; do not start UX/profile phases until recovery and
  execution gates pass.
- **[Risk] Journal and configuration migrations could strand old state.** → Keep old schemas
  readable, migrate only atomically on write, never auto-recover ambiguous v1 journals, and include
  migration fixtures for every supported version.
- **[Risk] Per-entry journal fsync increases mutation latency.** → Accept the cost at rename
  boundaries where durability matters; benchmark and batch only preparation metadata, not commit
  evidence.
- **[Risk] Built-in diff output could consume excessive CPU or terminal space.** → Enforce file,
  hunk, and total-output budgets with metadata fallbacks and focused selector modes.
- **[Risk] Resource defaults may reject legitimate asset-heavy skills.** → Publish defaults, provide
  bounded configuration overrides, and base initial ceilings on measured fixtures.
- **[Risk] Project-declared remotes expose internal host and repository names.** → Store only
  credential-free normalized connection data, make project declaration opt-in, and document that it
  is version-controlled.
- **[Risk] Generated metadata may make docs feel rigid.** → Generate only catalog/help facts and
  continue authoring explanatory README, skill, and wiki prose with parity checks.
- **[Risk] Correcting ignored flags and JSON version output can break accidental consumers.** →
  document the compatibility correction, provide exact examples, and test exit and envelope
  behavior before release.

## Migration Plan

1. Freeze the current command/help/JSON/package behavior in characterization tests and complete or
   rebase the current updater and release changes.
2. Add journal v2 readers/writers, nested discovery, recovery-required blocking, fault-injection
   fixtures, and recovery commands while retaining inspect-only v1 support.
3. Introduce operation guards, fatal error taxonomy, shared state-pair loading, filesystem locks,
   process policy, and resource budgets behind existing command behavior.
4. Introduce the command registry and typed handlers, preserving current command names and options;
   then correct ignored-option and JSON edge behavior with release notes.
5. Add disposable dry-run resolution, consistent offline/freshness behavior, diff review, human
   renderers, progress, help, completion, and plan-backed TUI.
6. Add configuration/profile schema v2 and project connection schema support with read-old,
   write-new migrations.
7. Enable packaged lifecycle, crash, cross-process, coverage, performance, artifact, and release
   gates; update README, bundled skill, and wiki in the same phase as each public behavior.
8. Run the full repository check and packaged smoke suite on Linux, macOS, and Windows before
   release. Rollback uses the previous npm release; new schemas remain backward-readable and no
   migration removes old user data.

## Open Questions

- Benchmark fixtures must establish the initial numeric resource and performance budgets before
  their CI gates change from report-only to blocking.
- The implementation must choose the Windows-safe npm entrypoint strategy after verifying standard
  Node installers, version managers, and package-manager shims in the existing OS matrix.
- Dynamic completion may be deferred behind static completion if its strict local-only latency
  budget cannot be met without coupling shell startup to project validation.
