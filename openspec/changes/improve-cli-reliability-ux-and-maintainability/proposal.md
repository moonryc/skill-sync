## Why

`skill-sync` has strong validation, redaction, exact-revision, and atomic-write foundations, but a
full audit found gaps where the recovery, cancellation, automation, and review contracts can
misdescribe or incompletely protect real filesystem state. Addressing those risks in one coordinated
change also creates the right foundation for clearer terminal workflows, extensible command
metadata, multi-library use, and stronger release and cross-platform verification.

## What Changes

- Make transaction journals discoverable and sufficient for deterministic crash recovery, stop
  after failed rollback, and add explicit recovery inspection, restore, and pruning workflows.
- Propagate cancellation, timeouts, noninteractive policy, and cross-process coordination through
  Git, npm, GitHub, cache, staging, and commit boundaries so results always match durable state.
- Validate project and global manifest/lock pairs consistently and apply bounded file, byte, depth,
  concurrency, and subprocess resource policies before mutation.
- **BREAKING** Reject scope and command options that were previously accepted but silently ignored,
  and correct `--json version` and parser-error attribution to the documented versioned envelope.
- Make dry-run, offline, refresh, freshness, and update-check behavior explicit and consistent
  across read-only, preview, project, and global workflows.
- Upgrade `diff` from file/hash classifications to safe review output with unified text patches,
  binary and large-file fallbacks, summary modes, and multi-skill selection.
- Add first-class human renderers, TTY-only progress, actionable next steps, richer help, shell
  completion, and a plan-backed TUI with first-run setup and diagnostics.
- Add named library profiles and project-level non-secret library selection so users can work across
  multiple libraries without repeatedly replacing one user-global default.
- Replace duplicated command metadata and project/global orchestration with typed registries and
  shared scope contracts that drive validation, help, JSON schemas, wiki catalog data, and parity
  tests.
- Harden the current release-management work for Windows, cache and allow opting out of update
  checks, document the no-telemetry boundary, and complete packaged lifecycle, coverage, artifact,
  and release validation.

## Capabilities

### New Capabilities

- `durable-cli-recovery`: Discover, inspect, resume or restore, and safely prune durable transaction
  journals and recoverable backups after interruption or failed rollback.
- `safe-cli-execution`: Keep cancellation, subprocesses, locks, state-pair validation, resource
  limits, and committed results consistent across project and global mutations.
- `cli-command-contracts`: Define and enforce typed command capabilities, arguments, options,
  machine output, dry-run, offline, freshness, and compatibility behavior.
- `reviewable-skill-changes`: Provide content-level, multi-skill review before publishing,
  discarding, restoring, or otherwise resolving local and canonical differences.
- `human-cli-workflows`: Provide concise human output, progress, help, completion, first-run
  onboarding, and plan-backed terminal UI reviews.
- `library-profiles`: Select and persist named or project-specific non-secret library connections
  with explicit precedence and identity checks.
- `cli-quality-platform`: Generate synchronized public surfaces from typed metadata and verify
  packaged lifecycle, cross-platform release management, coverage, performance, and artifact
  budgets.

### Modified Capabilities

<!-- None. The repository has no baseline OpenSpec capability specs to modify. -->

## Impact

- Affects transaction, recovery, Git/process, cache, state, reconciliation, installation, target,
  release, command, output, prompt, and TUI code throughout `libs/cli/src/`.
- Adds state and output schema migrations or compatibility handling where durable journal,
  configuration, and JSON contracts change.
- Adds fault-injection, cross-process, packaged-tarball, lifecycle, resource-budget, performance,
  and cross-platform tests under `libs/cli/tests/` and CI.
- Updates `README.md`, `skills/skill-sync/SKILL.md`, wiki reference and command catalog content, and
  automation/recovery/security documentation from the same command contract source where practical.
- Coordinates with `add-cli-update-and-version-check` and `release-on-main-merge`; it hardens and
  consumes those changes rather than defining a second release mechanism.
