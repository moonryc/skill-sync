## ADDED Requirements

### Requirement: Installed CLI version is available as a command
The CLI SHALL provide a top-level `version` command that prints the installed `@moonryc/skill-sync` package version as a standard semantic-version string followed by a newline. The existing `--version` and `-V` options SHALL remain available and SHALL produce the same version string. These version entry points SHALL not require project discovery, configuration, network access, or command execution.

#### Scenario: User prints the installed version with the command
- **WHEN** a user runs `skill-sync version`
- **THEN** the CLI exits successfully and writes only its installed semantic version to standard output

#### Scenario: User prints the installed version with the existing option
- **WHEN** a user runs `skill-sync --version` or `skill-sync -V`
- **THEN** the CLI exits successfully and writes the same installed semantic version that `skill-sync version` writes

### Requirement: User can explicitly update the global npm installation
The CLI SHALL provide a top-level `self-update` command that runs npm without a shell to install the published `@moonryc/skill-sync` package at the `latest` dist-tag in global scope. The command SHALL retain the existing skill `update` command for managed-skill reconciliation and SHALL report a successful self-update only after npm exits successfully.

#### Scenario: Global package update succeeds
- **WHEN** a user runs `skill-sync self-update` and npm successfully installs the package globally at `latest`
- **THEN** the CLI exits successfully and reports that the CLI update completed

#### Scenario: npm cannot update the package
- **WHEN** a user runs `skill-sync self-update` and npm is unavailable, fails, or returns a nonzero exit status
- **THEN** the CLI exits nonzero with an actionable, sanitized error and does not report that the update completed

#### Scenario: Existing skill update remains distinct
- **WHEN** a user runs `skill-sync update <id>`
- **THEN** the CLI performs its existing managed-skill reconciliation behavior and does not invoke npm to update the CLI package

### Requirement: TUI launch notifies users of a newer release
When the interactive TUI launches, the CLI SHALL perform a best-effort, HTTPS npm registry lookup of the published package’s `latest` dist-tag without delaying the initial TUI render or input handling. If that valid semantic version is strictly newer than the installed version, the TUI SHALL display one concise, low-priority footer indicator that identifies the installed and available versions and names `skill-sync self-update` as the update command.

#### Scenario: A newer stable package version is available in the TUI
- **WHEN** a user launches the interactive TUI and the npm registry reports a valid `latest` version newer than the installed package version
- **THEN** the TUI displays one low-priority footer indicator containing the installed version, available version, and `skill-sync self-update` command

#### Scenario: Installed package is current
- **WHEN** a user launches the interactive TUI and the registry reports an equal or older valid version
- **THEN** the TUI operates without an update indicator

#### Scenario: Registry lookup cannot complete
- **WHEN** the interactive TUI's registry lookup times out, is cancelled, fails, or returns invalid release metadata
- **THEN** the TUI remains usable without an update indicator or changed exit status

#### Scenario: Argument-driven CLI command is launched
- **WHEN** the user runs an argument-driven CLI command, including a JSON, help, version, or offline invocation
- **THEN** the CLI does not perform the registry lookup and does not emit an update indicator or notice

#### Scenario: Update indicator does not obscure TUI work
- **WHEN** a newer release is displayed while the user performs a TUI action or receives an operational error
- **THEN** the update indicator does not replace the action result or error, change focus, request confirmation, or block input
