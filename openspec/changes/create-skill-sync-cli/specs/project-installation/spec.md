## ADDED Requirements

### Requirement: Portable project tracking state

The system SHALL keep desired installation state in `skill-sync.json` and resolved installation state in `skill-sync.lock.json` at the project root. The manifest SHALL record its schema version, credential-free library identity, qualified skill IDs, targets, and relative destinations; the lock SHALL record the resolved library commit, canonical digest, installed base digest, and destination digests. Both files MUST use deterministic ordering, MUST contain no absolute paths or credentials, and MUST be written atomically.

#### Scenario: Track a new installation

- **WHEN** the first skill installation in a project succeeds
- **THEN** the CLI creates deterministic manifest and lock files that fully describe the logical skill, all selected targets, relative destinations, source commit, and digests

#### Scenario: Tracking write fails

- **WHEN** new skill copies are staged but the manifest or lock file cannot be atomically replaced
- **THEN** the CLI restores the project to its pre-installation state and does not leave untracked managed copies

### Requirement: Deterministic project-root resolution

Project-mutating commands SHALL use an explicit `--project <path>` when provided, otherwise the nearest enclosing Git working-tree root, otherwise the current directory. The resolved root MUST be reported in dry-run and JSON results, and every managed destination MUST remain within that root after real-path resolution.

#### Scenario: Run from a nested project directory

- **WHEN** `install` runs below a Git working-tree root without `--project`
- **THEN** the CLI places project state and target destinations relative to that root rather than the nested working directory

#### Scenario: Reject an escaping project path

- **WHEN** a configured or adapter-produced destination resolves outside the selected project root
- **THEN** the command returns a validation failure before copying or deleting any content

### Requirement: Built-in agent target adapters

The system SHALL provide built-in `codex` and `claude` target adapters that project one logical skill to `.codex/skills/<leaf-name>` and `.claude/skills/<leaf-name>` respectively. Each adapter SHALL expose detection, destination, and validation behavior through a common interface so future targets can be added without changing the installation and reconciliation domain logic.

#### Scenario: Suggest detected agents interactively

- **WHEN** a project contains both `.codex` and `.claude` conventions and `install` runs interactively without target arguments or configured defaults
- **THEN** the CLI suggests both detected targets and lets the user confirm one or both

#### Scenario: Require targets in automation

- **WHEN** `install` runs non-interactively without explicit targets and no valid target defaults exist
- **THEN** it fails with the missing-input status before creating project state or destination directories

### Requirement: Install selected skills into selected targets

`install [ids...]` SHALL resolve all selected catalog identities and targets before mutation, fetch one current library revision, validate every selected skill, copy canonical bytes into each selected target, and record the resulting project state. One logical skill installed for several targets SHALL remain one manifest entry with several projections.

#### Scenario: Install one skill for Codex and Claude

- **WHEN** a user selects `frontend/review-ui` and targets `codex` and `claude`
- **THEN** the CLI installs identical canonical content under both target roots and creates one tracked logical skill entry containing both destinations

#### Scenario: Install several catalog skills

- **WHEN** a user selects multiple valid skills whose target destinations do not collide
- **THEN** each skill is validated and installed in deterministic qualified-ID order from the same fetched library revision

### Requirement: Refuse unmanaged and qualified-name collisions

Installation MUST NOT overwrite, adopt, merge with, or delete an existing destination that is not already owned by the same tracked logical skill. If two selected qualified IDs map to the same target destination, the complete selection for that target MUST be rejected before mutation and the diagnostic SHALL name both qualified IDs and the colliding path.

#### Scenario: Unmanaged destination already exists

- **WHEN** `.codex/skills/review-ui` exists but is not tracked by skill-sync and an installation would use that path
- **THEN** `install` reports an unmanaged collision and leaves the existing directory and project tracking files unchanged

#### Scenario: Duplicate leaf names collide in one target

- **WHEN** `frontend/review-ui` and `backend/review-ui` are selected for Codex and both map to `.codex/skills/review-ui`
- **THEN** the CLI rejects the target selection before installing either skill and requires the user to choose one of the qualified IDs

### Requirement: Idempotent install and explicit target expansion

Installing a skill that is already tracked at the same canonical digest and targets SHALL be a no-op. Adding a new target to an existing unmodified tracked skill SHALL install the recorded or current canonical content into that target and extend tracking atomically. `install` MUST NOT act as an implicit update or overwrite a locally modified tracked destination.

#### Scenario: Repeat an identical install

- **WHEN** an installed skill, its selected targets, and the current library digest all match tracked state
- **THEN** `install` reports the skill as already installed and does not rewrite content, tracking files, or `.gitignore`

#### Scenario: Existing tracked content is outdated

- **WHEN** `install` selects an already tracked skill whose library digest advanced
- **THEN** the command leaves it unchanged and directs the user to `update` or `sync`

#### Scenario: Add a Claude projection

- **WHEN** a current unmodified skill is tracked only for Codex and the user installs it with Claude as an additional target
- **THEN** the CLI creates the Claude copy and adds its relative destination and digest without rewriting the Codex copy

### Requirement: Transactional skill copies

The system SHALL copy regular skill files to a staging location, verify their deterministic tree digest and destination containment, and atomically replace destination and tracking state. All target copies for one logical skill MUST commit or roll back together; independent skills MAY complete separately and a mixed result SHALL use the standardized partial-failure status.

#### Scenario: Second target fails during installation

- **WHEN** the Codex destination can be written but the Claude destination fails validation or replacement
- **THEN** the CLI removes or restores the staged Codex change, leaves tracking unchanged for that logical skill, and reports both target outcomes

#### Scenario: One independent skill fails

- **WHEN** one selected skill installs successfully and another independent skill fails after selection validation due to a filesystem error
- **THEN** the successful skill remains consistently installed, the failed skill is rolled back, and the command reports a partial result

### Requirement: Treat installed content as inert and bounded

Installation SHALL copy only validated regular files contained within the canonical skill root. It MUST reject symlinks, special files, nested Git repositories, absolute paths, traversal, and any source or destination whose real path escapes its allowed root, and MUST NOT execute copied scripts, hooks, filters, binaries, or package lifecycle actions.

#### Scenario: Skill contains an executable script file

- **WHEN** a valid canonical skill includes a regular script as documentation or an asset
- **THEN** installation may copy its bytes but never invokes it or grants permissions beyond the defined projection policy

#### Scenario: Skill contains an escaping symlink

- **WHEN** a selected skill includes a symlink whose target is inside or outside the skill root
- **THEN** installation rejects the skill before writing any target projection

### Requirement: Exact idempotent gitignore management

After selection and before installation, interactive `install` SHALL offer to ignore generated target copies; automation SHALL use an explicit option or configured default. When enabled, the CLI SHALL maintain one marked block in the project `.gitignore` containing only exact normalized paths for managed copies, preserve all bytes outside that block, avoid duplicate entries, and keep `skill-sync.json` and `skill-sync.lock.json` unignored.

#### Scenario: Add exact managed entries

- **WHEN** a user installs one skill for Codex and Claude and accepts the gitignore option
- **THEN** the managed block contains only the two exact destination paths and does not ignore either entire agent directory or the project tracking files

#### Scenario: Update an existing managed block

- **WHEN** `.gitignore` contains user rules and a prior skill-sync block and another managed destination is added
- **THEN** the CLI preserves the user-authored bytes, rewrites one deterministically ordered managed block, and adds no duplicate rule

#### Scenario: Decline gitignore management

- **WHEN** the user declines the option or passes the explicit no-ignore flag
- **THEN** installation does not modify `.gitignore` and still records the selected behavior in project state

### Requirement: Safe project uninstall

`uninstall [ids...]` SHALL remove only destinations owned by the selected tracked skills, update manifest and lock state, and remove their exact managed gitignore entries. It MUST NOT change the canonical library. Locally modified or divergent destinations MUST be refused unless the user supplies the explicit discard-local option and destructive confirmation, in which case the system SHALL create a recoverable backup before removal.

#### Scenario: Uninstall an unmodified skill

- **WHEN** a user confirms uninstall of a tracked skill whose destinations match their installed digests
- **THEN** the CLI removes all of that skill's managed target copies and tracking entries, updates the managed gitignore block, and leaves the library untouched

#### Scenario: Refuse to delete local edits

- **WHEN** an uninstall selection contains a locally modified destination without the discard-local option
- **THEN** the CLI preserves every destination and tracking entry for that logical skill and returns the conflict-refusal result

#### Scenario: Explicitly uninstall local edits

- **WHEN** the user previews and confirms uninstall with the discard-local option for a modified skill
- **THEN** the CLI backs up the managed copies and prior tracking metadata before atomically removing them from the project

### Requirement: Dry-run project mutations

`install` and `uninstall` SHALL support `--dry-run`, showing resolved project root, library revision, qualified IDs, targets, destination paths, tracking changes, gitignore edits, conflicts, and backups that a real run would create. A dry-run MUST NOT create directories, state files, cache mutations, backups, or `.gitignore` changes.

#### Scenario: Preview a first installation

- **WHEN** `skill-sync install frontend/review-ui --target codex --dry-run` runs in a project with no skill-sync files
- **THEN** the CLI reports every planned file and state change but leaves the project byte-for-byte unchanged
