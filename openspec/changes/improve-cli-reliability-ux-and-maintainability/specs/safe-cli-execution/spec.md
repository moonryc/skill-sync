## ADDED Requirements

### Requirement: Cancellation matches durable state
The CLI SHALL propagate one command-scoped cancellation signal through network, subprocess,
filesystem staging, hashing, and mutation services. It SHALL check cancellation before entering a
commit boundary and SHALL NOT report a committed operation as cancelled.

#### Scenario: Cancellation during remote access
- **WHEN** SIGINT or SIGTERM arrives during a Git, GitHub, or registry operation
- **THEN** the child operation is terminated, no commit begins, locks are released, and the CLI
  exits with the cancellation status

#### Scenario: Cancellation before commit
- **WHEN** cancellation is observed after staging but before the first destination mutation
- **THEN** staging is cleaned or journaled, destinations remain unchanged, and cancellation is
  reported

#### Scenario: Signal arrives after commit
- **WHEN** a signal arrives after the transaction has durably crossed its commit barrier
- **THEN** the CLI reports the committed result and any follow-up interruption warning rather than
  claiming that the operation was cancelled

### Requirement: Recovery-integrity failures stop a batch
The CLI SHALL distinguish an ordinary per-skill failure that completed rollback from a
recovery-integrity failure. A failed rollback, journal transition, lock ownership check, or
ambiguous commit SHALL stop all later mutations in the batch.

#### Scenario: One skill rolls back successfully
- **WHEN** an independent skill update fails and its transaction proves a complete rollback
- **THEN** the batch may continue according to the documented partial-result policy

#### Scenario: Rollback is incomplete
- **WHEN** any path cannot be restored or the journal cannot be durably updated
- **THEN** the batch stops immediately, no later skill mutates, and the result identifies recovery
  as required

### Requirement: State pairs are validated consistently
Every project and global state read SHALL validate schema versions, library identity, exact skill ID
sets, projection targets, projection destinations, uniqueness, containment, and manifest/lock
agreement before the state can guide inspection or mutation.

#### Scenario: Global projections diverge
- **WHEN** a global manifest and lock contain the same skill ID but different targets or
  destinations
- **THEN** status, diff, and mutation commands fail with invalid-global-state and perform no writes

#### Scenario: Project state is internally consistent
- **WHEN** the manifest and lock satisfy the shared state-pair contract
- **THEN** project and global services derive equivalent state classifications for equivalent
  fixtures

### Requirement: Shared resources are coordinated across processes
Cache refreshes, canonical library mutations, project mutations, global mutations, recovery, and
schema migration SHALL use filesystem-backed advisory coordination rather than process-local locks
alone.

#### Scenario: Two processes refresh one cache
- **WHEN** two CLI processes resolve the same library identity concurrently
- **THEN** refresh and snapshot publication serialize without corrupting repository, state, or tree
  data

#### Scenario: Stale lock is encountered
- **WHEN** a lock owner is no longer active or its metadata is malformed
- **THEN** the CLI reports a deterministic remediation path and does not silently steal the lock

### Requirement: Subprocess policy is centralized
Git, GitHub, npm, project-root discovery, and other child processes SHALL share an argument-array
runner with credential redaction, sanitized environment, configurable timeout, cancellation, and
an explicit interactive or noninteractive policy.

#### Scenario: Automation requires credentials
- **WHEN** `--json` or `--no-input` is active and Git or SSH would prompt for credentials
- **THEN** the subprocess fails promptly with a stable authentication error instead of hanging

#### Scenario: Initialization cannot access a remote
- **WHEN** the credential-free remote probe for `init` fails
- **THEN** the stable repository error includes a bounded, terminal-inert, credential-redacted Git
  reason plus repository-access and transport-specific authentication guidance
- **AND** configuration, cache, staging, and project state remain unchanged
- **AND** if repository creation already succeeded, the error states that the external repository
  may remain and must be inspected deliberately

#### Scenario: Hostile Git environment is present
- **WHEN** inherited variables attempt to redirect Git directories, worktrees, hooks, filters, or
  configuration
- **THEN** content and root-discovery operations ignore the unsafe variables and remain contained

#### Scenario: Subprocess exceeds timeout
- **WHEN** a child operation exceeds its configured deadline
- **THEN** it is terminated and the CLI reports a redacted timeout error without starting mutation

### Requirement: Content processing has resource budgets
The CLI SHALL enforce documented defaults and configurable safe ceilings for file size, total bytes,
file count, nesting depth, subprocess output, and concurrent filesystem work. Hashing SHALL stream
content where practical and retain only bounded inventory metadata.

#### Scenario: Oversized content is inspected
- **WHEN** a skill or library exceeds a configured resource budget
- **THEN** validation fails with a stable content-limit error before any managed destination changes

#### Scenario: Large valid library is inspected
- **WHEN** content remains within the configured budgets
- **THEN** the CLI uses bounded concurrency and memory while preserving deterministic ordering and
  digests
