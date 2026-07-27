## Why

The repository is currently a single root-level TypeScript package, which makes it difficult to add independently managed projects or use project-aware task orchestration. Converting it now establishes an Nx workspace boundary while preserving the existing CLI package and release contract.

## What Changes

- Convert the repository root into a private npm workspace managed by Nx.
- Move the existing source, tests, package helpers, and publishable metadata into an Nx library named `cli` at `libs/cli`.
- Preserve the published `skill-sync` package name, executable, tarball layout, Node support, and runtime behavior.
- Preserve existing root npm development and release commands as Nx-backed compatibility aliases.
- Stage the publishable package under `dist/libs/cli` and update CI, packaging checks, and documentation accordingly.

## Capabilities

### New Capabilities

- `nx-workspace`: Defines the Nx workspace structure, CLI library ownership, task orchestration, package staging, and compatibility requirements for development and release workflows.

### Modified Capabilities

None.

## Impact

- Affects repository layout, root and library package manifests, TypeScript/Vitest/ESLint configuration, build and packaging scripts, path-sensitive tests, CI, and development documentation.
- Adds Nx 23.1.0 as development tooling and configures npm workspaces while retaining the existing package lock workflow.
- Does not change public CLI commands, output contracts, exit codes, configuration formats, or installed package behavior.
