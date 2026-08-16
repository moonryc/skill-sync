# Skill Sync Resume Research

## Feature Summary

`skill-sync` is a globally installable TypeScript CLI for maintaining a versioned, Git-backed
library of reusable AI-agent skills and safely projecting selected skills into Codex and Claude
projects or user-level directories. It combines interactive and automation-friendly workflows with
conflict detection, dry-run plans, transactional writes, recovery tooling, and structured output.
The repository also contains a searchable Astro documentation site and an Nx-managed validation and
packaging pipeline.

## Best Starting Points

- `README.md` — product purpose, user workflows, safety model, and supported commands.
- `libs/cli/src/commands/command-registry.ts` — typed command, option, scope, and safety metadata.
- `libs/cli/src/application/` — library lifecycle, installation, reconciliation, diagnostics, and
  recovery use cases.
- `libs/cli/src/infrastructure/transactions.ts` — locking, journaling, staging, backup, and atomic
  replacement behavior.
- `libs/cli/tests/` — unit, integration, and packaged end-to-end coverage.
- `apps/wiki/src/content/docs/` — user and contributor documentation for the public CLI behavior.
- `.github/workflows/ci.yml` — cross-platform checks and npm package inspection.

## Notable Files

| File or directory | Role | Resume-relevant evidence |
| --- | --- | --- |
| `libs/cli/src/cli.ts` | CLI composition root | Connects the runtime, command program, and executor. |
| `libs/cli/src/domain/reconciliation.ts` | Core domain logic | Classifies local, remote, missing, modified, and conflicting skill states. |
| `libs/cli/src/application/project-installation.ts` | Project installation workflow | Plans and applies managed multi-target skill installation. |
| `libs/cli/src/application/global-skill-management.ts` | Global installation workflow | Supports user-level Codex and Claude skill management without project metadata. |
| `libs/cli/src/application/recovery.ts` | Recovery use cases | Inspects and resolves interrupted operations with explicit recovery evidence. |
| `libs/cli/src/ui/tui/` | Interactive terminal UI | Provides searchable catalog, selection, review, diagnostics, and confirmation flows. |
| `apps/wiki/` | Static documentation application | Astro/Starlight site with searchable guides, reference material, and troubleshooting. |
| `.github/workflows/ci.yml` | CI pipeline | Runs checks on Ubuntu, macOS, and Windows with Node.js 22 and 24 and inspects the npm artifact. |

## How It Connects

1. Commander routes CLI input through a typed command registry and workflow handlers.
2. Application services discover the Git-backed catalog and build a deterministic operation plan.
3. Domain reconciliation checks managed state, content digests, local edits, and conflicts.
4. Infrastructure adapters coordinate Git, cache, filesystem locks, journals, backups, and atomic
   writes.
5. Human-readable, TUI, or versioned JSON output reports the result; unit, integration, and packaged
   end-to-end tests verify the boundaries.

## Tests And Docs

- The current working tree contains 56 Vitest files across unit, integration, and end-to-end layers.
- CI runs the full formatting, lint, type-check, wiki-build, test, and package-smoke pipeline across
  six OS/Node combinations, with an additional generated-shell-completion validation job.
- The public behavior is synchronized across the repository README, bundled `skill-sync` agent
  skill, Astro wiki, and searchable command catalog.

## Open Questions

- No public adoption, download, or usage metric is established in the repository, so the resume
  entry should emphasize engineering scope and capabilities rather than users or downloads.
- The package manifest currently reports version `0.1.0`; avoid claiming a mature release history
  unless publication records are verified separately.

## Recommended Resume Entry

**Skill Sync** | <https://github.com/moonryc/skill-sync>  
**Role:** Sole Owner  
**Summary:** Built a cross-platform TypeScript CLI that manages a versioned, Git-backed library of
reusable AI skills and safely synchronizes them across Codex and Claude projects. Implemented
interactive and CI-friendly workflows with dry-run planning, conflict detection, transactional
writes, recovery tooling, and structured JSON output; shipped an Astro documentation site and
multi-platform CI validation.  
**Tools:** TypeScript, Node.js, Git, Nx, React, Ink, Astro, Vitest, GitHub Actions, Zod
