## ADDED Requirements

### Requirement: Global installation uses user-level agent destinations
The system SHALL install selected canonical skills into the supported user-level skill directory
for each explicitly selected agent target, without creating project manifests in the destination
directory.

#### Scenario: Install a global Codex skill
- **WHEN** the user runs `skill-sync install --global --target codex frontend/review-ui`
- **THEN** the CLI copies the skill to the platform-resolved user-level Codex skills directory,
  records the global intent and exact revision in user-level skill-sync state, and reports the
  absolute destination

#### Scenario: Global target is unsupported
- **WHEN** the user selects a target with no supported global destination
- **THEN** the CLI reports a validation error and performs no writes

### Requirement: Global state is isolated from project state
The system SHALL maintain a versioned global manifest and lock state in user-level skill-sync
storage, separate from any project's `skill-sync.json` and `skill-sync.lock.json`.

#### Scenario: Global installation from outside a repository
- **WHEN** a global install is run from a directory with no Git repository
- **THEN** the command succeeds if the library and global target are valid and does not create
  project state files in the current directory

### Requirement: Global reconciliation preserves safety guarantees
The system SHALL support global `sync`, `update`, `status`, and `uninstall` using the same digest,
collision, backup, dry-run, offline, lock, and local-edit safeguards as project workflows.

#### Scenario: Sync an unchanged global skill
- **WHEN** `skill-sync sync --global` finds a globally managed skill whose local copy is unchanged
- **THEN** it updates the copy to the safely reconciled canonical revision and updates global lock
  metadata

#### Scenario: Refuse an edited global copy
- **WHEN** a globally managed copy differs locally and the user omits the explicit discard option
- **THEN** the CLI reports the conflict, leaves the copy unchanged, and does not advance its lock

#### Scenario: Uninstall a selected global skill
- **WHEN** the user runs `skill-sync uninstall --global <id>` for an unmodified managed copy
- **THEN** the CLI removes only that global copy and its global metadata entry
