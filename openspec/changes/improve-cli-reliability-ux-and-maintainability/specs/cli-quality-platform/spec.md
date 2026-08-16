## ADDED Requirements

### Requirement: Public command surfaces stay synchronized
The typed command registry SHALL be the source for Commander registration, handler completeness,
help metadata, machine-output schema inventory, and the searchable wiki command catalog. Contract
tests SHALL verify README, bundled skill, and wiki references for every public command and option.

#### Scenario: Public option changes
- **WHEN** a command, option, output, workflow, or safety rule changes
- **THEN** validation fails until generated metadata and authored README, skill, and wiki guidance
  agree

#### Scenario: Documentation link is declared
- **WHEN** command metadata references a wiki page and anchor
- **THEN** the wiki build or link validator fails if the target does not exist

### Requirement: Project and global scopes share conformance tests
Project and global installation, adoption, status, diff, reconciliation, uninstall, recovery, and
state migration SHALL run through shared scope contracts and the same behavior fixtures, with
scope-specific destination adapters only where required.

#### Scenario: Equivalent project and global fixtures run
- **WHEN** conformance tests apply the same state transition in each scope
- **THEN** classifications, safety decisions, exit semantics, and JSON shapes agree except for
  documented scope paths

### Requirement: Packaged lifecycle is tested end to end
CI SHALL install the produced npm tarball into an isolated environment and exercise a local
Git-backed lifecycle through the executable from an unrelated working directory on supported
operating systems.

#### Scenario: Packaged lifecycle runs
- **WHEN** CI tests the publish artifact
- **THEN** it covers init, list, install, status, diff, canonical change, check, update, uninstall,
  JSON errors, cancellation, and recovery against a hermetic bare remote

#### Scenario: Windows self-update adapter is tested
- **WHEN** the production package updater runs on Windows
- **THEN** it invokes npm through a platform-safe argument-array mechanism without depending on
  direct execution of `npm.cmd`

### Requirement: Quality gates are measurable
CI SHALL publish coverage and performance reports, enforce ratcheted per-layer coverage thresholds,
and enforce regression budgets for representative catalog, status, hashing, and packaged startup
workloads.

#### Scenario: Coverage decreases below threshold
- **WHEN** changed code causes a configured layer threshold to fail
- **THEN** CI fails with the affected files and uncovered branches

#### Scenario: Representative workload regresses
- **WHEN** runtime, memory, file descriptor use, or Git invocation counts exceed the documented
  budget
- **THEN** the benchmark gate reports the regression and fails the applicable check

### Requirement: Release management is portable and privacy-explicit
Release checks and self-update SHALL be cross-platform, bounded, redacted, and covered by the
release-on-main workflow. Documentation SHALL state that the CLI emits no analytics or telemetry
and SHALL enumerate passive registry checks and their opt-out.

#### Scenario: TUI checks for an update
- **WHEN** update checks are enabled and the cache interval has elapsed
- **THEN** the CLI performs one bounded registry metadata request and emits no usage event

#### Scenario: Main release completes
- **WHEN** the release workflow publishes an eligible current-main package
- **THEN** provenance, tag, GitHub release, package smoke tests, and idempotency checks all succeed
  before users are notified

### Requirement: The package artifact is intentional
The publish artifact SHALL contain only runtime, legal, metadata, documentation, and source-map or
type files that serve a documented consumer. CI SHALL enforce compressed size, unpacked size, and
file-count budgets and SHALL verify repository, homepage, and issue metadata.

#### Scenario: Unexpected build outputs are packed
- **WHEN** declarations, maps, caches, tests, or other files exceed the allowlist or artifact budget
- **THEN** package inspection fails and reports the unexpected entries

### Requirement: Developer checks do not rewrite unrelated work
Pre-commit and CI checks SHALL be read-only unless a developer explicitly requests formatting.
Staged formatting workflows, if used, SHALL operate only on selected files and SHALL ensure staged
bytes match checked bytes.

#### Scenario: A commit is attempted with unrelated unstaged edits
- **WHEN** pre-commit validation runs
- **THEN** it does not rewrite, stage, or discard the unrelated files
