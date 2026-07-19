## 1. Package and Development Foundation

- [x] 1.1 Create the npm package metadata with native ESM, Node.js 22+ engines, a `skill-sync` bin entry, publish files, and an npm lockfile.
- [x] 1.2 Add TypeScript build configuration and a layered `src/` layout for commands, application services, domain models, ports, and infrastructure adapters.
- [x] 1.3 Add formatting, linting, type-checking, build, test, and packaged-CLI smoke-test scripts that can run in CI.
- [x] 1.4 Configure Vitest with isolated temporary-directory, fixture-library, fixture-project, and local bare-Git-remote helpers.

## 2. Domain Contracts and Durable State

- [x] 2.1 Implement versioned command result, structured error, JSON output, and exit-status domain contracts with credential-safe serialization tests.
- [x] 2.2 Implement portable lowercase slug, group path, qualified skill ID, selector, and case-fold collision validation.
- [x] 2.3 Implement deterministic regular-file inventory and SHA-256 tree digests with path traversal, symlink, special-file, nested-Git, and nested-skill-root rejection tests.
- [x] 2.4 Implement schema-validated `.skill-sync/library.json`, group marker, and `SKILL.md` front-matter models plus complete-error library validation.
- [x] 2.5 Implement platform-appropriate user config/cache/state paths, `SKILL_SYNC_CONFIG_HOME`, configuration precedence, URL credential rejection/redaction, and atomic config persistence.
- [x] 2.6 Implement deterministic `skill-sync.json` and `skill-sync.lock.json` schemas, migration/version checks, atomic persistence, and explicit/Git-root/current-directory project-root resolution.
- [x] 2.7 Implement advisory locks, operation journals, staging directories, atomic replacement, rollback, and recoverable backup storage primitives.

## 3. CLI Shell and Read-Only Experience

- [x] 3.1 Implement the root parser, `--help`, subcommand help, `--version`, global options, and registration for every specified command and namespace.
- [x] 3.2 Implement terminal/CI detection and a prompt adapter that enforces `--no-input`, explicit selectors, `--yes`, cancellation status, and destructive-option separation.
- [x] 3.3 Implement human stdout/stderr routing, `NO_COLOR` and `--no-color`, and exactly-one-object versioned `--json` rendering for success and failure.
- [x] 3.4 Implement catalog scanning that derives root and grouped logical skills without executing repository content and stops recursion below a skill root.
- [x] 3.5 Implement exact and unqualified selector resolution, ambiguity reporting, deterministic multi-selection, and complete-set validation.
- [x] 3.6 Implement `list` with group, query, agent, and installation-state filters plus deterministic human and JSON output.
- [x] 3.7 Implement read-only `info` and `validate` commands for configured libraries, qualified skills, installed skills, and explicit local source paths.

## 4. Git and Library Lifecycle

- [x] 4.1 Implement safe argument-array Git execution, HTTP-to-HTTPS upgrade, HTTPS/SSH/scp-style URL normalization, credential redaction, hook/filter isolation, and non-recursive submodule behavior.
- [x] 4.2 Implement the locked library cache, exact fetched-commit resolution, configured-branch handling, refresh behavior, and clearly marked stale read-only cache results.
- [x] 4.3 Implement `init <url>` for compatible remotes, confirmed initialization of empty remotes, idempotent reconnection, and refusal of nonempty incompatible repositories.
- [x] 4.4 Implement `init --create <owner/name>` through authenticated GitHub tooling with private-by-default visibility, transport selection, no-overwrite behavior, and config rollback on failure.
- [x] 4.5 Implement a clean-checkout library mutation coordinator that validates the complete result, generates commits, pushes without force, retries unrelated remote advances, and rejects touched-content divergence.
- [x] 4.6 Implement `add <path> [--group]` with local validation, missing group markers, existing-ID refusal, preview, commit, and pushed result metadata.
- [x] 4.7 Implement `publish [ids...]` with local/library diff, recorded-base checks, explicit target-source resolution, optimistic publication, and post-push project base updates.
- [x] 4.8 Implement `group list/create/rename/remove` with persistent markers, affected-ID previews, safe nested moves, recursive-removal protection, and orphaning warnings.
- [x] 4.9 Implement `library remove <id>` with destructive confirmation, Git-history recovery messaging, and a guarantee that project copies are not uninstalled.

## 5. Project Targets and Installation

- [x] 5.1 Define the target-adapter interface and implement Codex and Claude detection, relative destination mapping, containment validation, and future-adapter registration.
- [x] 5.2 Implement preflight target resolution that detects unmanaged destinations and cross-group leaf-name collisions before any project mutation.
- [x] 5.3 Implement `install [ids...]` selection and one-revision fetching, then transact identical canonical copies across all selected targets with manifest and lock updates.
- [x] 5.4 Implement idempotent reinstall behavior, explicit target expansion, and refusal to use `install` as an implicit update of outdated or locally modified content.
- [x] 5.5 Implement exact marked-block `.gitignore` management that preserves user bytes, records the chosen policy, and never ignores the project manifest or lock.
- [x] 5.6 Implement `uninstall [ids...]` for managed destinations only, including gitignore cleanup, modified-copy refusal, explicit discard confirmation, and backup creation.
- [x] 5.7 Implement complete `install` and `uninstall` dry-run plans with zero project, cache, backup, or ignore-file writes.

## 6. Reconciliation and Conflict Safety

- [x] 6.1 Implement the three-way digest classifier for current, outdated, locally modified, conflicted, missing, orphaned, and unmanaged-collision states across all target copies.
- [x] 6.2 Implement read-only `status` and per-skill `diff` with target-specific divergence, fetched revision, stale-cache, human, and JSON reporting.
- [x] 6.3 Implement bulk pull-only `sync` that uses one fetched revision, updates safe outdated skills, restores safe missing copies, skips dirty/conflicted skills, and never deletes or publishes implicitly.
- [x] 6.4 Implement selective/interactive `update [ids...]` on the same engine and make `update --all` behaviorally equivalent to `sync`.
- [x] 6.5 Implement `--discard-local` preview and non-interactive confirmation rules, recoverable backups, and atomic all-target replacement for sync, update, and uninstall.
- [x] 6.6 Implement per-skill rollback with independent batch progress, deterministic summaries, conflict status, and partial-failure status.
- [x] 6.7 Implement `--dry-run`, `sync --check`, and explicit cached-revision offline inspection/application semantics without falsely reporting freshness.

## 7. Configuration, Diagnostics, and Reliability

- [x] 7.1 Implement `config path/list/get/set/unset` with supported-key validation, precedence display, atomic writes, and secret rejection.
- [x] 7.2 Implement non-mutating `doctor` checks for Node.js, Git, GitHub tooling, authentication/access, config, cache, library schema, project state, and target destination permissions.
- [x] 7.3 Add signal and unexpected-error boundaries that roll back or journal in-flight work, return status 130 on cancellation, suppress expected stack traces, and redact all diagnostics.
- [x] 7.4 Add startup recovery that detects abandoned locks/journals/backups and reports safe remediation without silently modifying repositories.

## 8. Verification, Documentation, and Release

- [x] 8.1 Add unit tests for schemas, IDs, digests, selectors, state classification, config precedence, redaction, gitignore preservation, and output/exit contracts.
- [x] 8.2 Add filesystem integration tests for multi-target transactions, collisions, local edits, rollback, backups, uninstall, dry-run, and project-root containment.
- [x] 8.3 Add local-Git integration tests for HTTPS/SSH URL parsing, empty/incompatible init, validation, add, publish, group changes, deletion, remote races, and failed-push rollback.
- [x] 8.4 Add end-to-end packaged CLI tests for interactive adapters and fully specified `--no-input --json` workflows from unrelated project directories.
- [x] 8.5 Document installation, library layout, every v1 command and automation flag, Codex/Claude paths, conflict recovery, security boundaries, GitHub authentication, and CLI-only-policy limitations.
- [x] 8.6 Verify the final npm package name, configure prerelease and release metadata, and add CI jobs for supported Node.js/platform tests plus `npm pack` artifact inspection.
- [x] 8.7 Dogfood a private fixture library with the existing OpenSpec skills without adopting or overwriting this repository's current `.codex` and `.claude` copies.
- [x] 8.8 Run all formatting, linting, type-checking, unit, integration, end-to-end, OpenSpec validation, and packed-global-install smoke checks before publishing v1.
