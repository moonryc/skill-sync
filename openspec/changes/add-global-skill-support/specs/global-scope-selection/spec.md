## ADDED Requirements

### Requirement: Global scope is explicit and project scope remains the default
The system SHALL require an explicit global scope selector for global skill operations and SHALL
continue resolving project scope by default.

#### Scenario: Existing command without scope flag
- **WHEN** the user runs `skill-sync install frontend/review-ui` from a project
- **THEN** the CLI performs the existing project-scoped installation behavior

#### Scenario: Global scope is selected
- **WHEN** the user supplies `--global` to a supported project-like command
- **THEN** the CLI resolves global state and global target paths instead of the current project

#### Scenario: Conflicting scope selectors
- **WHEN** the user supplies both `--global` and `--project <path>`
- **THEN** the CLI returns a usage error and performs no library, project, or global writes

### Requirement: Scope is visible in inspection and diagnostics
The system SHALL identify whether reported state, destinations, conflicts, and repairs belong to
project or global scope.

#### Scenario: Inspect global status
- **WHEN** the user runs `skill-sync status --global`
- **THEN** output labels the result as global and shows user-level destination paths and global
  state locations

#### Scenario: Doctor checks global destinations
- **WHEN** the user runs `skill-sync doctor --global`
- **THEN** diagnostics check global state, permissions, destination containment, and lock/recovery
  health without requiring a project manifest
