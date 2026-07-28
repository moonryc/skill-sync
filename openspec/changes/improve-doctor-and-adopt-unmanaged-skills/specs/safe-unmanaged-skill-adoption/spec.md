## ADDED Requirements

### Requirement: Users can explicitly adopt an exact unmanaged target skill
The system SHALL provide an argument-driven adoption operation for a selected project or global
scope. It MUST accept an explicit qualified library skill ID and target projection, locate only the
corresponding supported target-root directory, validate it as inert skill data, and compare it with
the selected canonical library skill. It SHALL record normal manifest and lock entries only when
the local directory is an exact content match and SHALL leave that directory unchanged.

#### Scenario: Exact unmanaged project copy is adopted
- **WHEN** a valid unmanaged `.codex/skills/review-ui` directory exactly matches the selected
  canonical `frontend/review-ui` skill
- **THEN** the project manifest and lock record its Codex projection and the existing directory is
  neither copied nor modified

#### Scenario: Exact unmanaged global copy is adopted
- **WHEN** a valid unmanaged global Claude skill exactly matches the selected canonical skill
- **THEN** the global manifest and lock record its Claude projection without modifying the global
  target directory

### Requirement: Adoption rejects unsafe or ambiguous input without mutation
The system MUST reject adoption when the selected scope state is incomplete or invalid;
the target is unsupported or escapes containment; the inventory path is absent, invalid, a
symlink, managed, or not unmanaged; the qualified library ID is unknown or incompatible with the
target; the projection or ID conflicts with existing state; or the canonical and local directories
differ. On rejection it MUST leave the target directory, manifest, lock, `.gitignore`, and recovery
state unchanged.

#### Scenario: Divergent local skill is not adopted
- **WHEN** a valid unmanaged directory differs from the explicitly selected canonical library
  skill
- **THEN** adoption reports that an exact content match is required and leaves the directory and
  selected-scope state unchanged

#### Scenario: Unreliable state is not treated as empty
- **WHEN** the selected scope has a corrupt or incomplete manifest/lock pair
- **THEN** adoption reports the state problem and does not create a new tracking entry

#### Scenario: Duplicate leaf names are not inferred
- **WHEN** two catalog skills share the same leaf directory name
- **THEN** adoption requires the caller to provide one exact qualified ID and does not select one
  automatically

### Requirement: Adoption uses established durable-state safeguards
The system SHALL perform adoption through the selected scope's existing locking, validation,
journaling, backup, and atomic state-write mechanisms. It MUST recalculate lock metadata from the
canonical selected skill, preserve unrelated tracked skills, and retain the current install and
sync behaviors after adoption.

#### Scenario: Existing state is preserved while adopting one projection
- **WHEN** a scope already tracks other skills and a new exact unmanaged copy is adopted
- **THEN** only the selected skill/projection is added and existing tracking entries remain
  unchanged
