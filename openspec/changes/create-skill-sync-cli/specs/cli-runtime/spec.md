## ADDED Requirements

### Requirement: Globally installable command

The npm package SHALL declare a `skill-sync` executable and a Node.js engine range of version 22 or later, and a global npm installation on a supported runtime SHALL make that executable usable from any working directory without a project-local installation.

#### Scenario: Run the globally installed CLI in an unrelated project

- **WHEN** the package is installed globally with npm on a supported Node.js version and `skill-sync --help` is run in a project that does not depend on `skill-sync`
- **THEN** the operating system resolves the global `skill-sync` executable, it prints help, and it exits successfully

### Requirement: Discoverable command surface

The CLI SHALL expose `init`, `install`, `sync`, `update`, `add`, `publish`, `list`, `info`, `status`, `diff`, `uninstall`, `validate`, `config`, `doctor`, `library`, and `group` as top-level command entries, SHALL expose the library and group mutation subcommands defined by their capabilities, and SHALL provide help for the root command and every subcommand.

#### Scenario: Inspect root help

- **WHEN** a user runs `skill-sync --help`
- **THEN** the CLI exits successfully and lists every supported top-level command with a concise description

#### Scenario: Inspect subcommand help

- **WHEN** a user runs `skill-sync install --help`
- **THEN** the CLI exits successfully, describes the command's arguments and options, and performs no project or library mutation

#### Scenario: Invoke an unknown command

- **WHEN** a user invokes a command name that is not registered
- **THEN** the CLI prints an actionable usage error, suggests root help, exits with status `2`, and performs no mutation

### Requirement: Stable version reporting

The CLI SHALL support `skill-sync --version` and SHALL report the same semantic version that is present in the installed npm package metadata.

#### Scenario: Report the installed version

- **WHEN** a user runs `skill-sync --version`
- **THEN** the CLI prints only the installed package's semantic version in human-readable mode and exits successfully without accessing a project or skill library

### Requirement: Interactive and non-interactive execution

Commands SHALL prompt for omitted choices only when both input and output are interactive terminals. Passing `--no-input`, running with non-interactive input or output, or running in a detected CI environment MUST disable prompts; in those modes every required choice SHALL be expressible through documented arguments or flags, and an omitted required choice SHALL fail before mutation with exit status `2`.

#### Scenario: Prompt for an omitted interactive choice

- **WHEN** a command that requires a skill selection is run in an interactive terminal without an explicit selector
- **THEN** the CLI presents the documented selection prompt and continues using the user's answer

#### Scenario: Refuse to prompt in automation

- **WHEN** the same command is run with `--no-input`, without an interactive terminal, or in a CI environment and no selector is supplied
- **THEN** the CLI does not read from the terminal, identifies the missing argument or flag, exits with status `2`, and leaves project and library state unchanged

#### Scenario: Automatic confirmation does not force an overwrite

- **WHEN** a user supplies `--yes` to a command that encounters a local-edit or destination conflict
- **THEN** the CLI may accept ordinary confirmation prompts but MUST still refuse the conflict unless the capability-specific destructive override is also supplied

#### Scenario: Cancel an interactive prompt

- **WHEN** a user cancels a prompt or interrupts the CLI before an operation is committed
- **THEN** the CLI exits with status `130`, prints no stack trace, and leaves the operation's managed state unchanged

### Requirement: Deterministic machine-readable output

Every command SHALL support `--json`. JSON mode MUST disable prompts and ANSI styling, MUST write exactly one valid versioned JSON object to standard output, and SHALL use `{ "schemaVersion": <version>, "ok": true, "command": <name>, "data": <value> }` for success or `{ "schemaVersion": <version>, "ok": false, "command": <name>, "errors": [...] }` for failure. Each error SHALL include a stable machine-readable `code` and a human-readable `message`, while progress and diagnostics SHALL be written to standard error.

#### Scenario: Consume successful output in a script

- **WHEN** a fully specified command is run with `--json` and succeeds
- **THEN** standard output contains exactly one success object with stable field names, standard output contains no prompts or ANSI escapes, and the process exits with status `0`

#### Scenario: Consume failed output in a script

- **WHEN** a command is run with `--json` and fails validation
- **THEN** standard output contains exactly one failure object whose errors identify the validation failure, explanatory diagnostics do not corrupt standard output, and the process returns the standardized nonzero status

### Requirement: Human-readable stream and color conventions

In human-readable mode the CLI SHALL write requested result data to standard output and warnings, progress, and errors to standard error. It MUST disable decorative ANSI styling when `--no-color` is passed, when the `NO_COLOR` environment variable is present, or when the destination stream is not a terminal.

#### Scenario: Redirect command output

- **WHEN** a user redirects the output of a non-interactive `skill-sync list --no-color` command to a file
- **THEN** the file contains only the requested list data with no ANSI escape sequences and any warnings are emitted separately on standard error

### Requirement: User configuration management

The CLI SHALL store non-secret defaults in a schema-validated user configuration file located in the operating system's user configuration directory, SHALL honor `SKILL_SYNC_CONFIG_HOME` as an override for isolated environments, and SHALL expose `config path`, `config list`, `config get`, `config set`, and `config unset`. Configuration writes MUST be atomic, unsupported keys or invalid values MUST be rejected without changing the prior file, and command-line options SHALL take precedence over environment overrides, which SHALL take precedence over user configuration and built-in defaults.

#### Scenario: Persist a valid setting

- **WHEN** a user runs `skill-sync config set` with a recognized key and valid value
- **THEN** the CLI atomically persists the value at the path reported by `skill-sync config path`, and a subsequent `config get` returns it

#### Scenario: Reject an invalid setting without corrupting configuration

- **WHEN** a user attempts to set an unsupported key or a value that violates the configuration schema
- **THEN** the CLI exits with status `3`, explains the accepted value or keys, and preserves the prior configuration file byte-for-byte

#### Scenario: Apply configuration precedence

- **WHEN** a setting has different values in user configuration, its documented environment override, and an explicit command option
- **THEN** the command uses the explicit option without modifying either lower-precedence value

### Requirement: Credentials remain external

The CLI MUST use existing Git credential helpers, SSH agents, or authenticated GitHub tooling for repository authentication and MUST NOT persist access tokens, passwords, SSH private keys, credential-helper output, or credential-bearing repository URLs in its configuration, project metadata, logs, or JSON output.

#### Scenario: Reject a credential-bearing repository URL

- **WHEN** a user attempts to persist an HTTPS repository URL containing embedded credentials
- **THEN** the CLI refuses the value with exit status `3`, reports how to use external Git authentication, and does not echo or persist the credential

#### Scenario: Redact a credential from a dependency error

- **WHEN** Git or GitHub tooling returns an error message containing an authentication secret
- **THEN** the CLI replaces the secret with a redaction marker in both human-readable and JSON diagnostics

### Requirement: Stable process exit statuses

All commands SHALL use the same exit-status taxonomy: `0` for complete success, `1` for an unexpected internal failure, `2` for invalid invocation or missing automation input, `3` for configuration or content validation failure, `4` for repository, authentication, or network access failure, `5` when a conflict or unsafe overwrite is refused, `6` when an explicitly non-atomic multi-item operation completes only partially, and `130` for user cancellation or interrupt. Expected operational failures MUST NOT print a stack trace; an unexpected failure SHALL provide a redacted diagnostic and a stable error code.

#### Scenario: Classify expected failures consistently

- **WHEN** two different commands fail for the same class of configuration, access, or conflict error
- **THEN** both commands return the exit status assigned to that failure class and expose stable error codes describing their specific causes

#### Scenario: Report an unexpected failure safely

- **WHEN** an unhandled internal error reaches the command boundary
- **THEN** the CLI exits with status `1`, emits a redacted diagnostic with a stable internal-error code, and does not expose credentials in normal output

### Requirement: Non-mutating diagnostics

The `doctor` command SHALL inspect the active Node.js runtime, Git availability, configuration parseability, configured library URL, library access and authentication, cache state, and any project metadata found in the current project. It MUST evaluate all applicable checks, report each as `pass`, `warning`, `fail`, or `skipped` with remediation for non-passing checks, and MUST NOT create, repair, fetch, install, or otherwise mutate configuration, caches, repositories, or project files. It SHALL exit with status `0` when no check fails, status `3` when any local runtime, configuration, or project validation check fails, or otherwise status `4` when a repository, authentication, or network access check fails.

#### Scenario: Diagnose multiple problems in one run

- **WHEN** `skill-sync doctor` runs with both an invalid project manifest and an inaccessible configured library
- **THEN** it reports both checks rather than stopping at the first failure, supplies remediation for each, exits with status `3` because a local validation check failed, and makes no filesystem or repository changes

#### Scenario: Diagnose without remote access

- **WHEN** `skill-sync doctor --offline` is run with locally valid configuration and project metadata
- **THEN** local checks run, remote access checks are marked `skipped` with an explanation, no network operation is attempted, and skipped remote checks alone do not make the command fail
