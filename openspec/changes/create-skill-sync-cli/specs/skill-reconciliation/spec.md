## ADDED Requirements

### Requirement: Content-based reconciliation state

The system SHALL compare the library digest recorded at installation, the current library digest, and the current digest of every managed destination instead of relying on timestamps or optional skill metadata versions. It SHALL classify each logical skill as current, outdated, locally modified, conflicted, missing, orphaned, or an unmanaged collision.

#### Scenario: Library changed after installation

- **WHEN** every managed destination still matches its installed base digest and the current library digest differs from that base
- **THEN** the system reports the logical skill as outdated

#### Scenario: Local and library copies both changed

- **WHEN** at least one managed destination and the current library skill both differ from the installed base digest
- **THEN** the system reports the logical skill as conflicted

#### Scenario: Library entry was deleted

- **WHEN** a tracked logical skill no longer exists at the fetched library revision
- **THEN** the system reports the skill as orphaned without deleting its project copies

### Requirement: Status and diff inspection

The system SHALL provide `status` to report the reconciliation state of all managed skills and `diff` to preview content differences for a selected qualified skill. Both commands MUST support human-readable and structured JSON output and MUST NOT modify project or library content.

#### Scenario: Inspect drift without writing

- **WHEN** a user runs `skill-sync status` or `skill-sync diff group/name`
- **THEN** the command reports state or differences and leaves skill files, tracking data, `.gitignore`, and the library unchanged

#### Scenario: Compare divergent target copies

- **WHEN** copies of one logical skill in two managed agent targets have different content
- **THEN** `status` reports a conflict and `diff` identifies each divergent destination

### Requirement: Bulk synchronization

The `sync` command SHALL reconcile every tracked skill against one successfully fetched library revision. It SHALL update outdated unmodified copies, restore missing tracked copies, leave current copies unchanged, skip locally modified or conflicted copies, and never publish project content or implicitly delete project files.

#### Scenario: Refresh all safe outdated skills

- **WHEN** a project contains multiple outdated tracked skills with no local modifications and the user runs `skill-sync sync`
- **THEN** every managed destination is atomically replaced from the same fetched library revision and the tracking data records the new digests

#### Scenario: Skip a dirty skill while continuing

- **WHEN** one tracked skill is locally modified and another is safely outdated
- **THEN** `sync` skips and reports the locally modified skill, updates the safely outdated skill, summarizes the partial result, and exits with the defined partial-failure status

#### Scenario: Restore a missing managed copy

- **WHEN** a tracked destination is missing but the library skill still exists and no unmanaged file occupies the destination
- **THEN** `sync` restores the destination from the library and updates its recorded digest

### Requirement: Selective update

The `update` command SHALL use the same pull-only reconciliation engine as `sync` but limit changes to qualified skill identifiers selected by arguments or an interactive picker. `update --all` SHALL be behaviorally equivalent to `sync`.

#### Scenario: Select interactively

- **WHEN** a user runs `skill-sync update` in an interactive terminal without identifiers
- **THEN** the system presents tracked skills with their group-qualified names and states and changes only the confirmed selection

#### Scenario: Select non-interactively

- **WHEN** a user runs `skill-sync update group/one group/two --no-input`
- **THEN** the system evaluates only those identifiers without prompting and fails with a usage or validation result if a requested identifier is not tracked

### Requirement: Explicit handling of local edits

The system MUST refuse to overwrite locally modified or conflicted destinations unless the user supplies the destructive `--discard-local` option and confirms the preview when input is allowed. Before an authorized overwrite, the system SHALL create a recoverable backup containing the replaced files and their tracking metadata.

#### Scenario: Default overwrite refusal

- **WHEN** `sync` or `update` encounters a locally modified destination without `--discard-local`
- **THEN** the system leaves that destination and its tracking record unchanged, reports the refusal, and returns the defined conflict status when no other result takes precedence

#### Scenario: Explicitly discard local changes

- **WHEN** the user previews a locally modified skill and confirms `update group/name --discard-local`
- **THEN** the system stores a recoverable backup, replaces all managed destinations for that logical skill from the library, and records the new base digest

#### Scenario: Non-interactive destructive update

- **WHEN** `--discard-local` is supplied with `--no-input` but the command lacks the global non-interactive confirmation option
- **THEN** the system refuses the overwrite without changing files

### Requirement: Atomic per-skill application

The system SHALL stage and validate a replacement before changing destinations. All managed destinations and tracking entries for one logical skill MUST advance together or be restored to their pre-command state; a failure for one skill SHALL NOT corrupt successfully reconciled independent skills.

#### Scenario: One target write fails

- **WHEN** a skill is installed for Codex and Claude and replacement of one destination fails
- **THEN** the system restores both destinations and the tracking entries for that skill to their pre-command state and reports the failure

### Requirement: Preview and CI checks

Reconciliation commands SHALL support `--dry-run` without writes, and `sync --check` SHALL report whether a real sync would change or refuse any managed skill. A clean check SHALL exit successfully; drift, conflict, stale library data, or access failure MUST produce a non-success result distinguishable by the CLI exit contract.

#### Scenario: CI detects drift

- **WHEN** a user runs `skill-sync sync --check --no-input` and at least one tracked skill is outdated
- **THEN** the command reports the pending update, performs no writes, and exits non-successfully

### Requirement: Fresh library revision requirement

Before claiming a project is current or applying changes, the system SHALL attempt to fetch the configured remote and record the exact resolved commit. If fetching fails, cached data MAY be used only for inspection when clearly marked stale; mutating reconciliation commands MUST fail without changing project state unless the user explicitly requests an offline revision already present in the cache.

#### Scenario: Network unavailable during sync

- **WHEN** the configured remote cannot be fetched and no explicit offline revision was requested
- **THEN** `sync` reports the repository access failure and leaves project files and tracking data unchanged

#### Scenario: Inspect stale cached catalog

- **WHEN** the remote cannot be fetched but a cached revision exists and the user runs `status`
- **THEN** the system may calculate provisional states from the cache but marks the revision and result as stale and does not claim the project is current
