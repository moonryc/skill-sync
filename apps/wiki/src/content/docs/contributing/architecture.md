---
title: Repository architecture
description: Map the Nx workspace, CLI layers, package boundary, and static wiki.
---

`skill-sync` is an npm workspace orchestrated by Nx. It contains two independently buildable projects:

```text
apps/
  wiki/                 Astro + Starlight documentation application
libs/
  cli/                  publishable skill-sync npm package
openspec/               repository change specifications
dist/
  apps/wiki/            generated static wiki
  libs/cli/             staged npm package
```

The root package is private. The publishable package identity, runtime dependencies, source, tests, README, license, and package helpers belong to `libs/cli`.

## CLI layers

The CLI source is split by responsibility beneath `libs/cli/src`:

- `commands/` defines the Commander surface and maps invocations into handlers.
- `application/` implements library lifecycle, installation, reconciliation, configuration, diagnostics, selection, and recovery use cases.
- `domain/` contains identifiers, digests, library and project-state models, reconciliation logic, and typed results.
- `ports/` describes runtime and I/O boundaries.
- `infrastructure/` implements Git, filesystem, config, cache, transaction, and stable-serialization adapters.
- `runtime/` contains the cancellation and error boundary.
- `targets/` maps supported agents to contained project paths.
- `ui/` renders human and versioned JSON results and owns prompt behavior.

`src/cli.ts` assembles the runtime, program, and executor. The command program catches operational failures and converts them into typed result output rather than allowing arbitrary process errors to leak across the CLI boundary.

## Transaction boundaries

Canonical writes happen in a clean staged checkout and end in a normal non-force Git push. Project writes stage replacements, journal intent, verify digests, and commit each skill's target copies as one unit. Domain reconciliation decides whether an operation is safe; infrastructure performs only the authorized plan.

## Wiki boundary

The `wiki` project uses Astro and Starlight for content, navigation, static search, themes, and static generation. React is configured for opt-in islands; the command explorer is the only hydrated documentation component in the initial implementation.

Wiki content owns a typed command catalog but does not import `libs/cli` runtime modules. This prevents Node-specific implementation code from entering browser bundles and keeps the static site independently buildable.

## Nx ownership

Each project has an explicit `project.json`. Nx tracks inputs, target dependencies, cache behavior, and outputs while the underlying TypeScript, Vitest, ESLint, Astro, and packaging tools retain their normal configuration. Workspace-level OpenSpec, CI, and agent resources remain at the repository root.
