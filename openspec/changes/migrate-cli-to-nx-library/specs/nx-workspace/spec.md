## ADDED Requirements

### Requirement: Nx workspace and CLI library ownership

The repository SHALL be an npm workspace managed by Nx, with a private root package and an Nx project named `cli` located at `libs/cli`. The `cli` project SHALL be declared as a library and SHALL own the publishable `skill-sync` package metadata, runtime dependencies, source, tests, and package helpers.

#### Scenario: Nx discovers the CLI library

- **WHEN** a developer queries the Nx project graph after installing dependencies
- **THEN** Nx reports a library project named `cli` with source rooted at `libs/cli/src`

#### Scenario: The workspace root is not publishable

- **WHEN** package tooling inspects the root manifest
- **THEN** the root is marked private and the publishable `skill-sync` identity belongs to the `cli` workspace package

### Requirement: Nx-backed task compatibility

The workspace SHALL expose Nx targets for cleaning, building, type checking, linting, testing, test slices, and package smoke verification. Existing root npm command names SHALL remain available and SHALL route project work through the corresponding `cli` targets.

#### Scenario: Existing validation command remains usable

- **WHEN** a developer runs `npm run check` from the workspace root
- **THEN** formatting, linting, type checking, all tests, and package smoke verification complete through the configured workspace workflow

#### Scenario: Direct Nx execution is available

- **WHEN** a developer runs an individual target such as `nx build cli` or `nx test cli`
- **THEN** Nx executes that operation with declared inputs, dependencies, and outputs

### Requirement: Reproducible staged package

The `cli` build SHALL create a publishable staging directory at `dist/libs/cli`. The staged package SHALL retain the `skill-sync` name, current version source, public access and provenance settings, Node `>=22` engine, README, license, and `skill-sync` executable mapped to `dist/cli.js`.

#### Scenario: Build produces the package boundary

- **WHEN** the `cli` build target succeeds
- **THEN** `dist/libs/cli` contains the package manifest, README, license, and compiled `dist/cli.js` with its supporting JavaScript and declaration files

#### Scenario: Packed artifact preserves its contract

- **WHEN** package tooling packs `dist/libs/cli`
- **THEN** the tarball contains only the expected manifest, documentation, license, and `dist/**` files and exposes the `skill-sync` executable

### Requirement: CLI consumer behavior remains unchanged

The Nx migration MUST NOT alter the public CLI command surface, output schemas, exit codes, runtime configuration files, or installed execution behavior.

#### Scenario: Installed CLI retains observable behavior

- **WHEN** the staged package is globally installed and invoked from an unrelated directory
- **THEN** help, version, invalid-command handling, interactive cancellation, and non-interactive JSON workflows match the pre-migration behavior

### Requirement: Repository-level resources remain accessible

Workspace-level OpenSpec, agent, and automation resources SHALL remain at the repository root, and moved tests that depend on them SHALL resolve the workspace root explicitly.

#### Scenario: OpenSpec dogfood test uses repository assets

- **WHEN** the migrated integration suite runs from `libs/cli`
- **THEN** the dogfood test reads the root `.codex` and `.claude` OpenSpec skill sources without moving or modifying them

### Requirement: Continuous integration and release validation remain comprehensive

The workspace SHALL retain automated validation on Node 22 and 24 across Linux, macOS, and Windows, and SHALL inspect and upload the staged npm package in the package job.

#### Scenario: CI validates the migrated workspace

- **WHEN** the CI workflow runs for a push or pull request
- **THEN** dependency installation, the full compatibility check, cross-platform tests, staged package inspection, and artifact upload succeed
