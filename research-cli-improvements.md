# CLI Improvement Research

## Feature Summary

`skill-sync` already has an unusually strong safety model for a young CLI: exact revisions,
three-way reconciliation, explicit destructive intent, transaction journals, cross-process locks,
recovery commands, structured errors, and a versioned JSON envelope. The current working tree also
contains a large in-progress reliability and self-update effort, so the best next investments are
not more safety concepts or more top-level commands. They are consolidating the public command
contract, making changes genuinely reviewable, improving human-facing output and discoverability,
and adding measurable quality gates.

The recommended sequence is: finish the remaining process-boundary work, establish a typed command
registry, add content-level review and plan fingerprints, then build human output/help/completion on
those contracts. Profiles are valuable, but should follow these foundations unless multi-library
usage is already a frequent user problem.

## Prioritized Suggestions

### 1. Finish the shared subprocess boundary before expanding workflows

The new typed process runner exists, but the OpenSpec plan still shows migration of Git, npm, and
other subprocess call sites as incomplete. Finish that migration and its prompt/timeout tests first.
It closes a cross-platform reliability gap once, instead of hardening each future command
independently.

**Why now:** this is the last incomplete item in the current process-boundary foundation and later
features such as completion, profiles, richer diffs, and updates all depend on predictable timeouts,
cancellation, output limits, and noninteractive behavior.

### 2. Make one typed command registry the source of truth

Today the command model is duplicated across Commander registration, string-based dispatch,
handlers, README tables, the bundled skill, and the wiki catalog. Introduce typed command
definitions that own arguments, option choices, conflicts, scope support, mutation class, examples,
result schema, renderer, and documentation link. Generate Commander wiring and the searchable wiki
catalog from those definitions, then add parity tests for the authored README, skill, and long-form
wiki pages.

This will also remove `unknown[]` arguments and string-keyed option bags from command handlers and
allow invalid combinations to fail before filesystem or network work. Examples worth enforcing at
parse time include:

- `--project` conflicting with `--global`;
- selectors conflicting with `--all`;
- `--check` conflicting with mutating sync modes;
- `--target`, `--from`, `--agent`, and `--state` using declared choices;
- scope flags being rejected for commands that do not support them.

**Immediate parity fix:** `recovery list`, `inspect`, `resume`, `restore`, and `prune` are registered
in the CLI, but searches found no matching entries in `README.md`, `skills/skill-sync/SKILL.md`, or
the wiki content/catalog.

### 3. Turn `diff` and destructive previews into real review tools

The current `diff` surface describes digest changes, which tells users that content differs but not
whether they should publish, discard, update, uninstall, or recover it. Add a bounded, inert
three-way content diff (recorded base, local copy, canonical copy) with default patch output plus
`--stat` and `--name-only`. Treat binary and oversized files as metadata-only summaries and cap
hunks and total output.

Then represent every destructive or publishing preview as a typed reviewed plan containing scope,
library identity, revision, input digests, intended writes/removals, backups, and a stable
fingerprint. Confirmation should authorize that plan, and applying it should revalidate the same
fingerprint under the lock.

**User impact:** this is likely the largest confidence improvement in the normal workflow because
the user can judge the actual content before crossing an irreversible boundary.

### 4. Separate structured results from human presentation

The generic human fallback currently pretty-prints arbitrary objects as JSON. Many commands already
work around this with local formatting branches, while others return objects directly. Make
application services always return typed structured data and select a command-specific renderer at
the command definition.

Human output should consistently answer four questions: what scope was used, what changed, what was
skipped or conflicted, and what to do next. Add TTY-only progress on stderr, plus `--quiet` and
`--verbose`; keep JSON stdout as exactly one document and keep non-TTY output stable and bounded.

### 5. Improve discoverability without adding command clutter

The CLI currently exposes 21 top-level commands and relies mainly on Commander defaults. Generate
categorized help with examples, option choices, safety notes, documentation links, and typo
suggestions from the registry. Add static Bash, Zsh, Fish, and PowerShell completion, with optional
local-only completion for skill IDs, groups, targets, states, and profiles.

For bare invocation, keep the TUI behavior on interactive terminals, but guarantee concise help on
non-TTY input. For an unconfigured interactive installation, lead directly into a first-run
init/doctor workflow rather than presenting an empty general dashboard.

### 6. Add measurable release and performance gates

The test suite is broad, but Vitest currently declares no coverage thresholds, and the Nx targets
do not define startup, help, memory, artifact-size, or file-count budgets. Add report-only coverage
first, then ratchet thresholds by layer. Measure packaged CLI startup/help/completion latency and
representative catalog/diff operations. Enforce an npm tarball allowlist and size budget, and add a
production-faithful Windows self-update case.

This turns current expectations into regression barriers and is especially important because the
largest modules are already roughly 1,000–1,750 lines.

### 7. Refactor project/global duplication after contracts are stable

Project and global behavior currently lives in parallel large services. Introduce the planned
managed-scope adapter and a behavior matrix only after the command registry and result contracts are
in place. That ordering reduces refactor risk and gives the work a conformance harness.

Named profiles should come after this unless users are actively blocked by multiple libraries.
Profiles are useful, but they add configuration migration, identity isolation, cache separation,
and precedence complexity; they are a lower near-term return than review, output, and help.

## Best Starting Points

- [`libs/cli/src/commands/program.ts`](libs/cli/src/commands/program.ts) — current public command and
  option registration; the seed for a typed registry.
- [`libs/cli/src/commands/workflow-handler.ts`](libs/cli/src/commands/workflow-handler.ts) — the main
  string-based command orchestration layer and a major target for typed handler inputs.
- [`libs/cli/src/ui/output.ts`](libs/cli/src/ui/output.ts) — generic JSON/human rendering boundary;
  currently falls back to pretty-printed JSON for objects.
- [`libs/cli/src/application/project-reconciliation.ts`](libs/cli/src/application/project-reconciliation.ts)
  — project status/diff/reconciliation models and human formatters.
- [`libs/cli/src/application/global-skill-management.ts`](libs/cli/src/application/global-skill-management.ts)
  — parallel global behavior that motivates the managed-scope abstraction.
- [`openspec/changes/improve-cli-reliability-ux-and-maintainability/tasks.md`](openspec/changes/improve-cli-reliability-ux-and-maintainability/tasks.md)
  — the existing implementation sequence; many recommendations above are already specified there.
- [`apps/wiki/src/data/commands.ts`](apps/wiki/src/data/commands.ts) — manually duplicated searchable
  catalog and direct evidence for generated metadata/parity checks.

## Notable Files

| File | Role | What to inspect |
| --- | --- | --- |
| `libs/cli/src/commands/index.ts` | Startup, bare invocation, recovery warnings, Commander error conversion | Replace manual command attribution with registry/parser context; verify non-TTY behavior |
| `libs/cli/src/commands/default-executor.ts` | System/recovery/release dispatch | Split by typed command definitions and result schemas |
| `libs/cli/src/ui/tui/app.ts` | Interactive workflow | Reuse reviewed plans/render models; first-run and narrow-terminal behavior |
| `libs/cli/src/infrastructure/process-runner.ts` | New subprocess policy | Complete migration of Git/npm/doctor call sites |
| `libs/cli/src/application/recovery.ts` | Recovery discovery and presentation | Include in generated docs/help and reviewed-plan conventions |
| `libs/cli/vitest.config.ts` | Test configuration | Add coverage reporting and ratcheted thresholds |
| `libs/cli/project.json` | Nx build/test/package gates | Add performance, coverage, artifact, and packaged lifecycle targets |
| `README.md`, `skills/skill-sync/SKILL.md`, `apps/wiki/src/` | Three public documentation surfaces | Add parity checks and immediately document recovery commands |

## How It Connects

```text
typed command registry
  -> Commander parsing and validation
  -> typed handler invocation
  -> structured application result / reviewed plan
  -> command-specific human renderer or one JSON envelope
  -> generated help, completion, and wiki catalog
  -> parity, schema, packaged, and performance tests
```

The reviewed-plan path should be shared by argument-driven commands and the TUI. The managed-scope
adapter should sit below that path so project and global operations receive the same validation,
locking, recovery, rendering, and error semantics.

## Tests And Docs

The repository already has unit, integration, packaged end-to-end, cancellation-boundary,
cross-process-lock, recovery, TUI, and release-management coverage. The important missing gates are
explicit coverage thresholds, broad packaged lifecycle tests, performance/resource budgets,
completion smoke tests, output schema snapshots across all result classes, and command/docs parity.

The README and wiki offer good conceptual explanations and safe workflows, but the public command
facts are manually repeated. The absent recovery documentation demonstrates that this duplication
has already drifted in the current working tree.

## Open Questions

- Is multi-library use a real current pain point? If yes, move named profiles ahead of completion;
  otherwise keep profiles after review and output work.
- Which normal commands feel slow on real libraries? Measure before choosing concurrency and
  resource-budget defaults.
- Should shell completion be fully static in the first release, or is local cached skill-ID
  completion important enough to justify the hidden completion protocol immediately?
- Is the intended recovery command surface ready to document publicly, or is it still transitional
  within the in-progress reliability change?
