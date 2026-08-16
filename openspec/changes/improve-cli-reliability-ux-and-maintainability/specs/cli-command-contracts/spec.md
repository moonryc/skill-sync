## ADDED Requirements

### Requirement: Commands have typed capability definitions
Every public leaf command SHALL declare its arguments, local options, inherited options, supported
scope, interactivity, mutation class, output schemas, freshness behavior, and handler in one typed
registry. Registration and dispatch SHALL reject missing or duplicate definitions.

#### Scenario: A command is added
- **WHEN** a developer adds a public leaf command
- **THEN** type checking or contract tests fail until its parser, handler, output, help, and public
  metadata are complete

#### Scenario: A command receives an unsupported option
- **WHEN** a user passes `--global`, `--project`, or another option to a command that does not
  declare it
- **THEN** parsing fails with usage status before configuration, cache, network, or filesystem I/O

#### Scenario: A command receives an invalid or conflicting choice
- **WHEN** a user supplies an invalid declared choice or combines mutually exclusive selectors,
  policies, or review options
- **THEN** parsing fails with an actionable usage error before configuration, cache, network, or
  filesystem I/O

### Requirement: Common options are capability-scoped
The registry SHALL declare which common output, input-control, and scope options each leaf accepts.
Leaf help SHALL advertise only applicable common options, and invocation SHALL reject an explicitly
supplied inapplicable option before configuration, cache, network, project, or handler I/O.

#### Scenario: Input control is passed to a non-prompting command
- **WHEN** a user passes `--no-input` or `--yes` to a read-only or otherwise non-prompting leaf
- **THEN** the CLI fails with `OPTION_UNSUPPORTED` before command I/O and identifies the option to
  remove
- **AND** that leaf's help does not advertise either input-control option

#### Scenario: A prompt-capable command is automated
- **WHEN** a user requests help for or invokes a command whose interactivity is optional
- **THEN** help advertises `--no-input` and `--yes`, and invocation accepts them while still
  requiring explicit selectors and destructive intent

#### Scenario: TUI common options are inspected
- **WHEN** a user requests `tui --help` or explicitly passes a machine/input-control option to TUI
- **THEN** TUI help omits `--json`, `--no-input`, and `--yes`, and invocation rejects them before
  launching the interface
- **AND** broadly supported `--no-color` plus metadata-declared scope selectors remain available

### Requirement: Scope selection is explicit
Commands that support managed scope SHALL accept exactly one of project scope or global scope.
Project scope SHALL resolve an explicit project path or a contained enclosing Git root. Commands
that are user-global by definition SHALL reject managed-scope selectors.

#### Scenario: Conflicting scope selectors are passed
- **WHEN** `--global` and `--project <path>` are both supplied
- **THEN** the CLI emits one stable conflicting-scope usage error

#### Scenario: Scope is irrelevant to config
- **WHEN** `--global` or `--project` is passed to a config command
- **THEN** the CLI rejects the ignored selector rather than silently returning user configuration

### Requirement: JSON output is complete and stable
Every argument-driven command that accepts `--json`, including `version`, bare quick start, and
parser failures, SHALL emit exactly one versioned JSON object on stdout with the resolved command
identity, success flag, command-specific data or sanitized errors, and documented exit status.
Machine mode SHALL not emit progress or prompts; TUI SHALL reject JSON mode.

#### Scenario: Version JSON is requested
- **WHEN** the user runs `skill-sync --json version`
- **THEN** stdout contains one success envelope whose data includes the installed semantic version

#### Scenario: Nested command parsing fails
- **WHEN** a nested command is missing an argument and root options occur before or after it
- **THEN** the error envelope names the actual nested command and does not mistake an option value
  for a command

#### Scenario: JSON schema evolves
- **WHEN** a machine-output contract changes incompatibly
- **THEN** its schema version changes and migration guidance is published before removing the old
  contract

### Requirement: Dry-run is write-free
`--dry-run` SHALL calculate an application-equivalent plan without changing project files, global
state, canonical library content, persistent cache state, backups, journals, or locks. It MAY use a
disposable fetched snapshot that is removed before exit.

#### Scenario: Preview runs with a cold cache
- **WHEN** a network connection is available but no verified persistent snapshot exists
- **THEN** dry-run may fetch into disposable storage, returns a complete plan, and leaves the
  persistent cache unchanged

#### Scenario: Preview runs without network
- **WHEN** dry-run is combined with an explicit offline source
- **THEN** it uses only the selected verified cached revision and marks the plan non-authoritative
  with respect to the remote

### Requirement: Offline and freshness behavior is capability-scoped
The registry SHALL declare offline behavior per command. `status` and `doctor` SHALL accept a
network-skipping `--offline` flag; `sync` and `update` SHALL accept only an explicit full cached
revision. Commands that do not declare offline mode, including `list`, `info`, and `diff`, SHALL
reject the option before I/O. Every stale fallback SHALL remain visibly non-current.

#### Scenario: Read-only offline command runs
- **WHEN** `status` or `doctor` uses `--offline`
- **THEN** no network operation occurs and both human and JSON output identify cached freshness

#### Scenario: Unsupported read-only offline option is passed
- **WHEN** `--offline` is passed to `list`, `info`, `diff`, or another leaf that does not declare it
- **THEN** parsing rejects the option before configuration, cache, network, project, or handler I/O
- **AND** a stale fallback instead tells the user to retry when remote access is available

#### Scenario: Offline mutation lacks a revision
- **WHEN** a real mutation requests offline mode without a full exact revision
- **THEN** it fails before planning or writing and explains how to select a verified revision

#### Scenario: Stale fallback is used
- **WHEN** a read-only remote refresh fails and a verified stale snapshot is allowed
- **THEN** every output mode includes a visible stale warning and never describes the result as
  current

### Requirement: Update checks are bounded and optional
Passive CLI update checks SHALL use a time-bounded, nonblocking cache with a documented refresh
interval and SHALL honor command offline mode, configuration, and an environment opt-out. Normal
argument-driven commands SHALL not perform passive registry checks.

#### Scenario: Cached update result is fresh
- **WHEN** the TUI launches within the update-check cache interval
- **THEN** it uses the cached result without contacting the registry

#### Scenario: Update checks are disabled
- **WHEN** the user disables update checks or requests offline operation
- **THEN** no registry request occurs and all other TUI behavior remains available

### Requirement: Configuration mutations report durable changes truthfully
Configuration writes SHALL preserve schema-v1 library invariants, remain atomic, and report whether
a write occurred plus every affected key. Human and JSON output SHALL distinguish a real change
from an already-satisfied no-op.

#### Scenario: Configured library remote is unset
- **WHEN** `config unset library.remote` runs against a schema-v1 library record
- **THEN** the CLI atomically removes and reports `library.remote`, optional `library.branch`, and
  `library.transport` while preserving independent `defaults.*` values
- **AND** JSON returns `unset: true`, `changed: true`, and the complete ordered `changedKeys`

#### Scenario: SSH transport is unset
- **WHEN** `config unset library.transport` runs while transport is SSH
- **THEN** the persisted remote is normalized to HTTPS and both `library.remote` and
  `library.transport` are reported as changed

#### Scenario: Config value is already unset
- **WHEN** `config unset <key>` finds no applicable persisted change
- **THEN** it performs no configuration write and human output says no change
- **AND** JSON returns `unset: false`, `changed: false`, and `changedKeys: []`

#### Scenario: Dependent library setting lacks a remote
- **WHEN** a user sets `library.branch` or `library.transport` before `library.remote`
- **THEN** validation points to the exact prerequisite command
  `skill-sync config set library.remote <repository-url>`
