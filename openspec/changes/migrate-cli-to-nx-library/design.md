## Context

`skill-sync` is currently a single ESM TypeScript package whose source, tests, build configuration, package metadata, and release scripts all live at the repository root. Its release checks depend on a specific tarball layout (`dist/cli.js` plus declarations and supporting modules), runtime version discovery relative to `package.json`, and cross-platform verification on Node 22 and 24. The repository also contains root-level OpenSpec and agent assets that are inputs to a dogfood integration test and must remain workspace-level resources.

## Goals / Non-Goals

**Goals:**

- Establish a conventional Nx workspace with a `cli` library at `libs/cli`.
- Make the library the owner of the publishable `skill-sync` package while keeping the root private.
- Preserve existing developer commands, package contents, executable behavior, and release checks.
- Give Nx accurate inputs, dependencies, and outputs so repeatable tasks can be cached and orchestrated.

**Non-Goals:**

- Changing CLI commands, output schemas, exit codes, runtime configuration, or supported Node versions.
- Splitting the CLI's internal modules into additional Nx projects.
- Replacing npm, TypeScript compilation, ESLint, Prettier, Vitest, or the package-lock workflow.
- Moving root-level OpenSpec, agent, or GitHub workflow resources into the library.

## Decisions

### Use a private integrated workspace with a publishable npm workspace library

The root package will become `skill-sync-workspace`, set `private: true`, and declare `workspaces: ["libs/*"]`. The existing publishable metadata and runtime dependencies will move to `libs/cli/package.json`, whose npm package remains `skill-sync@0.1.0`; `libs/cli/project.json` will name the Nx project `cli`, set `projectType` to `library`, and set `sourceRoot` to `libs/cli/src`.

This keeps package ownership aligned with the Nx project and leaves room for future projects. Keeping publish metadata at the root was rejected because it would preserve an ambiguous workspace/package boundary.

### Wrap the existing toolchain in explicit Nx targets

The `cli` project will declare explicit `clean`, `build`, `typecheck`, `lint`, `test`, test-slice, and `smoke-pack` targets using Nx task orchestration around the existing commands. Target inputs, dependencies, and outputs will be declared in `nx.json` and project configuration; build-dependent tests and packaging checks will depend on `build` rather than launching ad hoc nested builds.

Using explicit targets is preferred over changing to inferred plugin defaults because it minimizes migration risk for the current NodeNext compiler layout and Vitest behavior. Bypassing Nx from root scripts was rejected because it would not provide a consistent project graph or caching boundary.

### Build a staged package at `dist/libs/cli`

TypeScript output will be written beneath `dist/libs/cli/dist`, while the build stages the library manifest and root README/license at `dist/libs/cli`. Packaging, smoke installation, dry runs, and CI artifacts will operate on that directory. This retains the public `bin.skill-sync = "dist/cli.js"` contract and lets runtime code continue resolving the staged package version relative to compiled modules.

Changing the public bin path to a flattened Nx output was rejected because it would create an unnecessary package-layout change. Building into `libs/cli/dist` was rejected in favor of a single workspace-level output tree that Nx can clean and cache.

### Separate runtime package metadata from workspace tooling

Runtime dependencies remain in the library package manifest; Nx, TypeScript, linting, formatting, testing, and type packages remain root development dependencies. The root retains compatibility scripts that invoke Nx targets, while release scripts version the library manifest and pack or publish the staged directory.

This ensures the published manifest contains only consumer-relevant dependencies and avoids duplicating development tooling across workspace packages.

### Adjust only repository-relative assumptions

Source and test-relative imports will remain structurally unchanged when moved together. Path-sensitive helpers will explicitly distinguish the library root, workspace root, and staged package root. In particular, the OpenSpec dogfood test will resolve the workspace root, while CLI e2e and smoke tests will resolve the staged package.

## Risks / Trade-offs

- **Risk: packaging from the wrong directory could publish the private workspace or omit required files.** → Release scripts, CI, and smoke tests will always address `dist/libs/cli` explicitly and assert the complete tarball file set and metadata.
- **Risk: moved tests may silently resolve `libs/cli` when they require the repository root.** → Audit all `import.meta.url`, `dirname`, and relative repository-root calculations and retain the OpenSpec dogfood coverage.
- **Risk: Nx caching could reuse incomplete build or package outputs.** → Declare the full staged directory as the build output and include manifests, shared configuration, README, license, sources, and helper scripts in target inputs.
- **Trade-off: explicit targets require more configuration than inferred tasks.** → The configuration preserves exact current behavior and can be simplified later after the migration is stable.

## Migration Plan

1. Add the private npm/Nx workspace configuration and library manifest without changing runtime code.
2. Move source, tests, and package helpers into `libs/cli`; update shared and project TypeScript, Vitest, ESLint, and Prettier paths.
3. Configure Nx targets and staged-package assembly, then update path-sensitive tests and scripts.
4. Route existing npm commands and release workflows through Nx and the staged package.
5. Regenerate the package lock, run every target and compatibility alias, inspect the tarball, and execute the full cross-platform CI workflow.

Rollback is a single repository revert because the migration does not alter persisted user data, remote services, or released runtime formats.

## Open Questions

None. The workspace location, package ownership, command compatibility, output layout, package manager, and Nx version are fixed by this change.
