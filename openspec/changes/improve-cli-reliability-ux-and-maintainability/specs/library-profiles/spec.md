## ADDED Requirements

### Requirement: Users can manage named library profiles
The CLI SHALL support portable named profiles containing a credential-free normalized remote,
branch, transport preference, and identity. It SHALL provide commands to list, inspect, create,
update, select, and delete profiles without storing credentials.

#### Scenario: A profile is created
- **WHEN** the user creates a profile with a supported HTTPS or SSH remote
- **THEN** the CLI normalizes and validates the remote, stores its identity and non-secret settings,
  and reports the profile location

#### Scenario: A profile contains credentials
- **WHEN** a remote includes user credentials, tokens, query secrets, or fragments
- **THEN** profile creation fails and no credential-bearing value is written

#### Scenario: An in-use profile is deleted
- **WHEN** a profile is the selected user default or referenced by managed global state
- **THEN** deletion requires explicit reassignment and confirmation

### Requirement: Projects can declare a non-secret library connection
A project SHALL be able to record its normalized credential-free library remote, identity, and
branch in version-controlled project state so a collaborator can resolve the intended library
without changing a user-global default.

#### Scenario: Collaborator opens a configured project
- **WHEN** project state declares a valid library connection and external authentication is
  available
- **THEN** project commands resolve that library without requiring `init` to replace user settings

#### Scenario: Project connection and identity disagree
- **WHEN** the normalized project remote does not match the stored identity
- **THEN** the CLI rejects project state before network access or mutation

### Requirement: Library selection has deterministic precedence
Effective library selection SHALL use command option, environment, project connection, selected user
profile, legacy user default, then built-in absence. `config list` and `doctor` SHALL report the
effective source without exposing credentials.

#### Scenario: Explicit profile is selected
- **WHEN** `--profile <name>` is supplied to a library-aware command
- **THEN** the named profile overrides project and user defaults for that invocation, subject to
  managed-state identity checks

#### Scenario: Project connection is present
- **WHEN** no command or environment override is supplied and the project declares a connection
- **THEN** project scope uses the project connection while unrelated global scope keeps its selected
  user profile

#### Scenario: Selected source conflicts with managed state
- **WHEN** an override resolves to a different identity than existing project or global state
- **THEN** the CLI refuses the operation and explains how to select the recorded library or migrate
  deliberately

### Requirement: Existing configuration migrates safely
The CLI SHALL continue to read the current single-library user configuration and identity-only
project state. A write SHALL migrate legacy user settings to a default profile atomically, and
project connection enrichment SHALL be explicit or derived only from an identity-matching source.

#### Scenario: Legacy user configuration is read
- **WHEN** the current configuration contains one library object and no profiles
- **THEN** commands treat it as the legacy default without changing the file during read-only use

#### Scenario: Legacy configuration is updated
- **WHEN** a config mutation requires the new schema
- **THEN** the CLI writes an equivalent default profile atomically and preserves unrelated defaults

#### Scenario: Legacy project identity cannot be resolved
- **WHEN** project state has only an identity and no configured source matches it
- **THEN** the CLI requests an explicit matching profile or remote and performs no state rewrite

### Requirement: Caches remain isolated by identity
Named profiles and project connections that resolve to different library identities SHALL use
separate repositories, snapshots, locks, freshness metadata, and update-check context.

#### Scenario: Two profiles use different libraries
- **WHEN** commands for two profiles run concurrently
- **THEN** cache and lock paths cannot overwrite or mislabel the other profile's revision
