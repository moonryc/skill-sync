## ADDED Requirements

### Requirement: Recovery discovery covers every managed scope
The CLI SHALL discover nonterminal operation journals, advisory locks, rollback artifacts, and
recoverable backups beneath every project and global scope directory without following symbolic
links or changing the discovered state.

#### Scenario: Nested project journal is discovered
- **WHEN** a project operation leaves a nonterminal journal beneath its project-key directory
- **THEN** startup inspection, `doctor`, and `recovery list` report the journal and its owning scope

#### Scenario: Global journal is discovered
- **WHEN** a global operation leaves a nonterminal journal beneath the global scope directory
- **THEN** recovery inspection reports the journal instead of treating recovery state as clean

#### Scenario: Unsafe recovery entry is encountered
- **WHEN** a recovery directory contains a symbolic link, malformed manifest, or escaping path
- **THEN** the CLI reports a blocking recovery validation error without following or deleting it

### Requirement: Journals support deterministic recovery
Before the first destination mutation, the CLI SHALL durably record the transaction root identity,
scope, destination, candidate path, rollback path, intended action, content identity, and per-entry
state needed to determine whether each rename occurred. The CLI SHALL durably advance each entry
after moving the original and after committing the candidate.

#### Scenario: Process stops between renames
- **WHEN** the process terminates after moving an original destination but before committing its
  replacement
- **THEN** the persisted journal identifies the moved original and exact rollback location

#### Scenario: Process stops after candidate commit
- **WHEN** the process terminates after committing a replacement but before transaction completion
- **THEN** the persisted journal identifies the committed candidate and retains enough evidence to
  finish or restore the transaction

#### Scenario: Legacy journal is discovered
- **WHEN** recovery inspection finds an older journal that lacks deterministic recovery metadata
- **THEN** the CLI reports it as inspect-only and SHALL NOT guess, replay, or delete its state

### Requirement: Recovery-required state blocks mutation
The CLI SHALL refuse new mutations in a scope that has an unresolved nonterminal or failed
transaction, while allowing read-only inspection and explicit recovery commands.

#### Scenario: Mutation starts with unresolved recovery state
- **WHEN** an install, adopt, sync, update, uninstall, publish, group, or library mutation targets a
  scope with unresolved recovery state
- **THEN** it exits with a stable conflict-class error and points to `recovery inspect`

#### Scenario: Read-only inspection starts with unresolved recovery state
- **WHEN** status, diff, list, info, validate, doctor, or recovery inspection targets the scope
- **THEN** it remains read-only and includes the unresolved recovery warning

### Requirement: Recovery operations are explicit and reviewable
The CLI SHALL provide `recovery list`, `recovery inspect <id>`,
`recovery resume <id>`, and `recovery restore <id>` workflows. Resume and restore SHALL produce a
dry-run plan, validate current paths against journal evidence, require explicit confirmation, and
complete atomically or leave updated actionable recovery state.

#### Scenario: Restore preview is requested
- **WHEN** the user runs `recovery restore <id> --dry-run`
- **THEN** the CLI reports each path and action without modifying destinations or recovery data

#### Scenario: Recovery evidence matches
- **WHEN** the user confirms a restore and every destination, candidate, and rollback artifact
  matches the journal
- **THEN** the CLI restores the selected pre-operation state and marks the journal rolled back

#### Scenario: Forward recovery evidence matches
- **WHEN** the user confirms resume and every remaining candidate and committed destination matches
  the journal
- **THEN** the CLI completes the selected intended state and marks the journal committed

#### Scenario: Recovery evidence is ambiguous
- **WHEN** a destination or hidden artifact differs from the journal evidence
- **THEN** restore refuses the operation and reports the exact conflicting paths

#### Scenario: Recovery root is selected through an alias
- **WHEN** `recovery resume`, `recovery restore`, or `recovery prune` selects a project through an
  explicit symlink path or a discovered Git root
- **THEN** the CLI canonicalizes that root before matching evidence, planning, or taking a scope lock
- **AND** global recovery actions likewise use the canonical home root

### Requirement: Recovery pruning is bounded and safe
The CLI SHALL provide explicit pruning for terminal journals and verified backups only, SHALL
support dry-run, SHALL never prune unresolved recovery state, and SHALL never accept an unresolved
filesystem root or broad recursive target from user input.

#### Scenario: Terminal recovery records are pruned
- **WHEN** the user selects verified terminal records and confirms `recovery prune`
- **THEN** only the selected records and their proven-owned artifacts are removed

#### Scenario: Unresolved record is selected for pruning
- **WHEN** a nonterminal, failed, malformed, or ambiguous record is selected
- **THEN** pruning refuses it and preserves every associated path

### Requirement: Abandoned advisory locks have an explicit safe recovery path
The CLI SHALL provide `recovery unlock <id>` as a preview-first operation for one valid advisory
lock record. Owned advisory locks SHALL persist a heartbeat by refreshing their lock-file
modification time every 15 seconds. Unlock SHALL remove only a bounded lock file whose recorded
owner is on the current host, whose process is proven absent, and whose fixed 60-second crash grace
has elapsed from the later of metadata creation and the last persisted heartbeat. It SHALL bind
application to the exact reviewed path and owner metadata. Confirmed applies SHALL serialize per
stable record with a crash-visible recovery action lock and SHALL revalidate the path, owner, grace,
and reviewed fingerprint while holding that lock. The selected lock's parent directory SHALL be
durably synchronized before success is reported; an ambiguous synchronization SHALL preserve the
recovery action lock as evidence. Human and JSON inspection and preview results SHALL NOT expose the
internal advisory-lock `ownerToken`. The CLI SHALL refuse active, foreign-host, too-young,
malformed, changed, or otherwise unverifiable lock evidence.

#### Scenario: An owned advisory lock persists liveness
- **WHEN** skill-sync holds an advisory lock for an active operation
- **THEN** it refreshes the lock file's modification time every 15 seconds without changing its
  recorded owner metadata

#### Scenario: A local lock owner is gone and the crash grace elapsed
- **WHEN** `recovery unlock <id> --dry-run` selects a valid local advisory lock whose recorded process
  is no longer active and at least 60 seconds have elapsed since the later of its metadata creation
  time and persisted lock-file modification time
- **THEN** the CLI shows the exact lock, owner, scope, and plan fingerprint without changing it
- **AND** confirmed application acquires the per-record recovery action lock, revalidates the same
  evidence and grace while holding it, removes only that lock file, and durably synchronizes its
  parent directory before reporting success

#### Scenario: Lock ownership cannot be disproved
- **WHEN** the selected lock belongs to an active process, a different host, malformed metadata, or
  evidence that changed after review, or fewer than 60 seconds have elapsed since the later of its
  metadata creation time and last persisted heartbeat
- **THEN** unlock refuses the operation, preserves the lock, and reports why it cannot safely prove
  abandonment

#### Scenario: Two applies target one stable lock record
- **WHEN** concurrent confirmed unlocks target the same stable recovery ID
- **THEN** one apply holds the crash-visible recovery action lock while the other refuses without
  removing or changing the selected lock

#### Scenario: Lock deletion durability is ambiguous
- **WHEN** the selected lock is unlinked but synchronizing its parent directory fails or is
  otherwise ambiguous
- **THEN** unlock does not report clean completion and preserves the per-record recovery action lock
  as discoverable evidence for `recovery list` and inspection

#### Scenario: Lock evidence is rendered as JSON
- **WHEN** a user requests JSON recovery inspection or an unlock preview
- **THEN** safe owner fields and the plan fingerprint are returned without the internal
  `ownerToken`
