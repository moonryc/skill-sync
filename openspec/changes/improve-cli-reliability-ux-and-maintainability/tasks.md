## 1. Baseline and change coordination

- [x] 1.1 Inventory the current CLI command, option, output, state, cache, lock, and subprocess surfaces, including the in-progress update/version-check and release changes, and record the affected files and existing tests in the change notes.
- [x] 1.2 Capture packaged CLI baseline results for unit, integration, end-to-end, type, lint, coverage, performance, and Windows-relevant behavior so later gates use explicit thresholds.
- [x] 1.3 Define the migration checkpoints and compatibility matrix for journal schema v1/v2, user config schema v1/v2, existing project state, and the current JSON output contract.

## 2. Durable journals and explicit recovery

- [x] 2.1 Define and test journal schema v2 with a root fingerprint, deterministic repository-relative candidate and rollback paths, per-entry durable states, and terminal-state metadata.
- [x] 2.2 Implement atomic journal transitions with file and directory durability guarantees, including failure-injection tests around every write, rename, and commit boundary.
- [x] 2.3 Implement safe recursive discovery of owned journals, locks, and backups across supported managed scopes without following unsafe paths or treating unrelated files as recovery evidence.
- [x] 2.4 Block mutating commands when unresolved recovery evidence exists and return actionable human and JSON diagnostics identifying the affected scope and recovery command.
- [x] 2.5 Add `recovery list` and `recovery inspect` commands with bounded human output, stable JSON results, scope filtering, and read-only behavior tests.
- [x] 2.6 Add `recovery resume` with dry-run planning, confirmation rules, fingerprint revalidation, idempotency, interruption tests, and refusal when evidence is insufficient.
- [x] 2.7 Add `recovery restore` with dry-run planning, confirmation rules, deterministic rollback validation, idempotency, and partial-failure tests.
- [x] 2.8 Add `recovery prune` that removes only terminal or provably owned stale artifacts, with dry-run support and tests proving unresolved or foreign evidence is preserved.
- [x] 2.9 Add migration handling for v1 journals and fixtures proving supported evidence can be inspected or recovered without silent reinterpretation.
- [x] 2.10 Canonicalize selected project and global roots before resume, restore, or prune matches recovery evidence, plans work, or takes a scope lock.
- [x] 2.11 Add preview-first `recovery unlock` for a single valid same-host lock with dead-process proof, exact owner revalidation, confirmation, refusal tests, and synchronized public guidance.

## 3. Mutation, cancellation, and state safety

- [x] 3.1 Introduce a commit-aware operation guard that distinguishes pre-commit cancellation, deferred cancellation during commit, committed success, and proven rollback.
- [x] 3.2 Route signals and command cancellation through the operation guard and add integration tests for interruption before, during, and after durable commit.
- [x] 3.3 Define a fatal recovery-integrity error taxonomy and update batch execution so only entries with proven rollback may continue after an individual failure.
- [x] 3.4 Build a shared project/global state-pair loader that validates metadata, managed content, identity, digests, and missing-half conditions before any mutating plan is created.
- [x] 3.5 Replace process-local mutation correctness with portable filesystem locks that encode scope identity and ownership, including stale-lock, contention, crash, and cross-process tests.
- [x] 3.6 Revalidate plan fingerprints, selected revisions, state identity, and content digests after acquiring the filesystem lock and immediately before commit.

## 4. Process, filesystem, and resource boundaries

- [x] 4.1 Centralize child-process execution behind a typed runner with noninteractive defaults, sanitized hostile Git environment variables, cancellation, output bounds, and configurable timeouts.
- [x] 4.2 Migrate Git, package-manager, updater, and other subprocess call sites to the shared runner and add timeout and unexpected-prompt regression tests.
- [ ] 4.3 Define command resource budgets for traversal depth, file count, file size, aggregate bytes, subprocess output, network response size, and concurrency.
- [ ] 4.4 Enforce resource budgets in discovery, hashing, diffing, fetch, recovery, validation, and packaging paths with actionable human and JSON failures.
- [ ] 4.5 Replace unbounded file reads and hashing with streaming implementations and add large-file and high-file-count regression fixtures.
- [ ] 4.6 Add bounded concurrency to independent filesystem and remote operations while preserving deterministic result ordering and cancellation behavior.

## 5. Typed command contracts and validation

- [x] 5.1 Define a typed command registry containing names, aliases, scope support, arguments, options, conflicts, defaults, examples, result schemas, help metadata, and documentation links.
- [ ] 5.2 Generate or configure Commander parsing and dispatch from the registry so every parsed option is either consumed or rejected before filesystem or network I/O.
- [x] 5.3 Normalize command scope and common-option selection, advertise only applicable inherited options, and reject irrelevant, conflicting, or unsupported options before I/O with suggestions and stable error codes.
- [ ] 5.4 Define one versioned JSON envelope for success, planned changes, warnings, and errors, including correct command and nested-operation attribution.
- [ ] 5.5 Migrate every command to emit exactly one JSON document in JSON mode and add schema snapshots covering success, validation failure, partial batch failure, cancellation, and recovery-required states.
- [ ] 5.6 Add registry conformance tests that fail when a command, option, handler input, result type, help entry, or output schema drifts from the declared contract.
- [x] 5.7 Make config unset atomic and truthful for coupled schema-v1 library fields, no-op writes, changed-key JSON, empty-array presentation, and dependency remediation.

## 6. Dry-run, offline, freshness, and update checks

- [ ] 6.1 Define a shared execution-mode policy for dry-run, offline, refresh, exact revision, quiet, verbose, interactive, and noninteractive behavior.
- [ ] 6.2 Refactor dry-run planning so it may use disposable temporary fetches but never mutates managed state, persistent caches, configuration, locks, journals, or working-tree files.
- [ ] 6.3 Implement consistent offline resolution that uses only verified local data and produces actionable missing-data errors without attempting network access.
- [ ] 6.4 Implement consistent exact-revision, freshness, and `--refresh` semantics across read, review, install, update, publish, and recovery-adjacent workflows.
- [ ] 6.5 Finish the bounded cached version-check flow with explicit opt-out, no command-failure coupling, no dry-run writes, and deterministic JSON attribution.
- [ ] 6.6 Add write-boundary and network-boundary tests for the execution-mode matrix across project and global scopes.

## 7. Reviewable changes and plan integrity

- [ ] 7.1 Implement a built-in bounded unified line diff for inert skill content with deterministic headers, truncation markers, binary/oversize handling, and no external executable dependency.
- [ ] 7.2 Extend review workflows to compare local, recorded base, and canonical content and expose patch, stat, and name-only views.
- [ ] 7.3 Add multiple skill selectors, `--all`, and explicit target selection with deterministic ordering and validation before remote or filesystem work.
- [ ] 7.4 Define typed reviewed plans for destructive and publishing operations that carry selected revision, scope identity, input digests, intended writes, and rollback expectations.
- [ ] 7.5 Require confirmation against the rendered reviewed plan and revalidate the same plan under lock before applying it.
- [ ] 7.6 Add tests for stale plans, changed revisions, changed local content, bounded diff output, terminal escape content, and batch review failures.

## 8. Human output, help, completion, and interactive workflows

- [x] 8.0 Deliver a novice-first entry slice: make empty project status successful and actionable, make bare non-TTY invocation print a write-free quick start, show setup/doctor actions for an unconfigured TUI, and make recovery warnings lead through `recovery list` to a valid record-specific command.
- [ ] 8.1 Separate structured application results from presentation and implement concise command-specific human renderers with stable summaries and actionable next steps.
- [ ] 8.2 Add TTY-aware progress on stderr with quiet suppression, verbose detail, no-color support, terminal-width handling, and no contamination of JSON stdout.
- [x] 8.3 Generate categorized command help, option choices, examples, documentation links, and unknown-command/option suggestions from the command registry.
- [x] 8.4 Make bare non-TTY invocation print bounded help and exit deterministically without entering an interactive flow.
- [x] 8.5 Add Bash, Zsh, Fish, and PowerShell completion generation from the static registry with snapshot and shell smoke tests.
- [ ] 8.6 Add optional local-only dynamic completion for skill and profile identifiers with strict latency and result bounds and no network access.
- [x] 8.7 Build a first-run interactive workflow for initialization and diagnostics that uses the same application plans, validation, confirmation, and commit path as noninteractive commands.
- [ ] 8.8 Build the broader TUI workflow around typed plans and fingerprints, including cancellation, accessibility, keyboard-only operation, narrow-terminal behavior, and non-TTY fallback tests.
- [x] 8.9 Deliver and document the novice-readable presentation slice for TUI doctor findings, configuration values, catalog inspection, and project/global status and diff summaries, including actionable bounds and next steps.
- [x] 8.10 Make empty global status succeed online and offline before library/cache resolution, with truthful structured state, exact setup/list guidance, no writes, and retained validation for existing state.
- [x] 8.11 Make standalone human install previews print a complete exact apply handoff containing resolved IDs or `--all`, sorted repeated targets, resolved gitignore policy when applicable, project/global scope, a safe explicit-project placeholder, and the reviewed fingerprint.
- [x] 8.12 Add novice-safe discovery recovery: declare `show` as the read-only `info` alias, return at most three conservative exact-ID candidates for valid unknown selectors, render scope-correct exact `info` or `list` retries, preserve candidates in JSON, and keep every mutation fail-closed without fuzzy reconstruction.

## 9. Named profiles and project library configuration

- [ ] 9.1 Define user configuration schema v2 for credential-free named profiles, selected profile metadata, remote identity, branch/ref defaults, cache identity, and migration versioning.
- [ ] 9.2 Implement profile list, show, create, update, remove, and select operations with validation, atomic writes, human output, and JSON contracts.
- [ ] 9.3 Add a version-controlled project library manifest for remote, identity, and branch/ref selection without storing credentials or machine-specific secrets.
- [ ] 9.4 Implement and test precedence as command option, environment, project manifest, selected profile, then legacy default.
- [ ] 9.5 Refuse operations when resolved library identity conflicts with existing managed state, cache, lock, journal, or reviewed-plan identity.
- [ ] 9.6 Implement read-old/write-new migration from legacy configuration, including backups, idempotency, invalid-config diagnostics, and rollback tests.
- [ ] 9.7 Isolate caches, locks, temporary fetches, and recovery evidence by resolved library identity and add profile-switching and concurrent-profile tests.

## 10. Shared project/global architecture

- [ ] 10.1 Introduce a managed-scope adapter that encapsulates project and global roots, configuration, state pairs, locks, journals, caches, and display labels.
- [ ] 10.2 Refactor application use cases to depend on the managed-scope contract instead of duplicating project/global branches.
- [ ] 10.3 Remove obsolete compatibility wrappers and duplicated validation only after registry and scope conformance tests cover every public command.
- [ ] 10.4 Add a project/global behavior matrix that exercises equivalent validation, planning, locking, recovery, output, and error semantics for supported commands.

## 11. Packaging, release, and quality gates

- [ ] 11.1 Add packaged-tarball end-to-end tests for the full lifecycle: initialize, install, review, update, publish, uninstall, recover, profile switching, JSON mode, and completion generation.
- [ ] 11.2 Add crash-injection and true cross-process integration suites that run against packaged entrypoints and verify journals, locks, rollback, resume, and restore behavior.
- [ ] 11.3 Add production-faithful Windows self-update coverage, including npm entrypoint replacement, rollback, locked-file behavior, and user-facing recovery guidance.
- [ ] 11.4 Establish enforced coverage thresholds and performance budgets for startup, help, completion, discovery, diff, and representative batch operations.
- [ ] 11.5 Add release artifact allowlists and size budgets that reject credentials, local configuration, caches, fixtures, source maps not intended for publication, and unexpected files.
- [ ] 11.6 Verify portable package metadata, supported Node and platform declarations, executable entrypoints, provenance, privacy/no-telemetry statements, and release workflow permissions.
- [ ] 11.7 Harden pre-commit and CI checks so verification is read-only by default, never rewrites unrelated files, and reports the exact remediation command.

## 12. Documentation parity and final verification

- [ ] 12.1 Update `README.md` for the final command surface, safety model, recovery workflow, profiles, review modes, JSON contract, offline/dry-run semantics, completion, and TUI behavior.
- [ ] 12.2 Update `skills/skill-sync/SKILL.md` so agent guidance matches every changed command, option, output contract, safety boundary, and migration rule.
- [ ] 12.3 Update the relevant wiki pages and `apps/wiki/src/data/commands.ts` from the typed registry, including examples, cross-links, migration guidance, and troubleshooting.
- [ ] 12.4 Add automated parity and link checks across the CLI registry, README, skill, wiki command catalog, generated completion metadata, and JSON schemas.
- [ ] 12.5 Run formatting, lint, typecheck, wiki build, unit, integration, end-to-end, packaged smoke, coverage, performance, artifact, and release validation and resolve all failures.
- [ ] 12.6 Perform manual acceptance passes on macOS, Linux, and Windows for recovery, cancellation, profiles, human output, completion, non-TTY behavior, and self-update, recording any platform exceptions.
- [ ] 12.7 Confirm the coordinated update/version-check and release changes are either incorporated or explicitly superseded, then mark every OpenSpec requirement and task with its verification evidence.
