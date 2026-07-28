## Context

`skill-sync` already separates Commander parsing, workflow orchestration, pure catalog/query
formatting, target adapters, state storage, and safe reconciliation. It has a small Inquirer prompt
adapter for missing selector input, but it does not provide a persistent navigation model or an
overview of the selected scope. The CLI is deliberately safe: library content is read as data,
mutation is guarded by preflight/confirmation/transactions, and non-interactive output is a
single JSON result when requested.

The new interface needs to make the common flows visually discoverable while leaving those
boundaries intact. It must work alongside the in-progress global-scope change, whose selected
managed scope determines both persisted state and the agent directories that can be inspected.

## Goals / Non-Goals

**Goals:**

- Give interactive users a keyboard-accessible, full-screen way to browse groups and skills,
  select installs, inspect reconciliation state, and perform an explicitly confirmed operation.
- Preserve the behavior of every existing subcommand, argument, option, exit code, human output,
  and `--json` output for scripts and CI.
- Show valid untracked on-disk skills in the selected project's or global scope's supported target
  directories without executing their contents or treating them as managed.
- Reuse the current installation, reconciliation, validation, collision, backup, lock, and
  confirmation services rather than reimplementing them in presentation code.

**Non-Goals:**

- Replacing the argument-driven CLI, adding a graphical/web interface, or changing machine output
  to describe the terminal layout.
- Importing, adopting, publishing, deleting, or overwriting an unmanaged skill from the UI.
- Scanning arbitrary repository directories for possible skills; discovery is limited to known
  selected-scope agent target roots.
- Adding arbitrary configurable agent targets or a general file manager in this change.

## Decisions

- **Two additive entry points: no-subcommand interactive launch and `tui`.** When `skill-sync` is
  invoked without a subcommand, it SHALL start the UI only when both input and output are terminals
  and neither `--json` nor `--no-input` was requested. `skill-sync tui` provides an explicit,
  documented entry point and accepts the existing scope-selection options. An invocation with any
  existing subcommand remains on the current Commander path. A TUI request with no usable terminal,
  `--json`, or `--no-input` fails with a clear usage error and a suggested argument-driven command;
  it never emits escape sequences or opens a prompt. This preserves pipe/CI determinism while
  making the normal bare invocation friendly.

- **Use a maintained full-screen terminal renderer with a thin adapter.** Add Ink and its
  maintained test renderer (at a Node 22-compatible version) behind a `ui/tui` runtime interface.
  Ink provides focusable lists, key handling, cleanup, and deterministic component testing that
  the existing one-shot Inquirer prompts cannot. The adapter owns terminal lifecycle and receives
  injected capabilities/streams in tests; domain and application modules do not import Ink.
  Hand-rolled ANSI rendering was rejected because resize, cleanup, focus, color, and accessibility
  behavior would become another unsafe runtime boundary. Keeping the existing prompt adapter
  remains appropriate for argument-driven commands.

- **Model screens as a finite navigation state machine over read models.** A controller loads a
  scope-aware dashboard model, then transitions among Overview, Library Groups, Skill Details,
  Install Selection, Install Review, Managed Skills, Unmanaged Skills, and Error/Help overlays.
  It exposes a consistent keyboard model: arrows/Tab move focus, Space toggles a multi-selection,
  Enter activates, Backspace/Escape returns, and `q` exits. Search filters IDs and descriptions
  without fetching or modifying the library. The view renders status badges from catalog and
  reconciliation read models and respects `--no-color`; a narrow terminal gets a readable compact
  layout rather than a clipped two-pane screen.

- **Invoke application workflows directly through a typed UI action port.** The controller obtains
  catalog, status, target, and unmanaged-inventory read models through new application-facing
  adapters. When a user confirms an action, it constructs a typed request for the existing install,
  sync, update, diff, or status workflow and presents the returned `CommandResult`; it does not
  shell out to `skill-sync`, parse human output, or duplicate validation. Opening screens and
  changing selection are read-only. A failed operation remains visible as a structured error and
  leaves the user on a recoverable screen.

- **Make destructive and reconciliation choices explicit.** The UI never syncs or installs on
  screen entry. Its review page lists selected qualified IDs, targets, scope, and each planned
  operation before confirming. It uses normal installs by default and exposes local replacement
  only after a user deliberately enables the same `discard-local` option and confirms it. Existing
  collision, local-edit, Git, lock, backup, stale-cache, offline, and cancellation semantics stay
  authoritative in the shared workflow.

- **Use a bounded, data-only unmanaged-skill inventory.** Add a scope-aware scanner that obtains
  only the known Codex/Claude target roots from target adapters and inspects direct candidate skill
  directories with the existing safe skill-directory validation rules. It compares normalized
  target/path pairs against the selected scope's valid manifest/lock projections. A valid directory
  with no matching managed projection is reported as unmanaged with its target, path, name, and
  validation result. Invalid state or inaccessible directories produce an explicit inventory issue;
  they must not cause every discovered path to be labeled untracked. The scanner never executes
  files, follows content as instructions, alters disk, or expands its search beyond these roots.

- **Keep global scope an explicit input.** The dashboard receives a resolved project or global
  managed-scope object instead of inferring a scope from which directory happens to contain the
  running terminal. It shows the selected scope and destination paths. Project scope remains the
  default; the UI can offer global scope only when the global-skill management capability is
  available, and an unavailable scope is shown as unavailable rather than silently redirected.

## Risks / Trade-offs

- [A full-screen renderer conflicts with redirected streams or test terminals] → Gate it on both
  TTYs, isolate streams behind an adapter, and assert no-TTY/JSON/no-input behavior in CLI tests.
- [UI code bypasses established safety checks] → Limit actions to typed calls into existing workflow
  services and cover controller-to-request mappings with contract tests.
- [Unmanaged inventory mistakes corrupted state for untracked content] → Require a valid state pair
  for association; surface a state/inventory error and preserve uncertainty otherwise.
- [Large libraries become slow or visually unwieldy] → Load summaries first, filter client-side,
  defer detail/inventory scans until their screen is opened, and render virtualized or paged lists.
- [The in-progress global-scope change changes storage abstractions] → Define the TUI boundary in
  terms of its resolved managed-scope interface and sequence its integration after that interface
  is stable.
- [Terminal UI dependencies enlarge the CLI package] → Keep the renderer isolated to the interactive
  entry point and verify its Node 22/package size impact during packaging checks.

## Migration Plan

1. Add renderer/runtime, routing, controller, and read-model contracts without changing current
   command handlers or state formats.
2. Implement catalog/install and managed-status screens against existing project workflows; then
   integrate the resolved global-scope abstraction when its change is complete.
3. Add bounded unmanaged discovery, action reviews, error recovery, and terminal cleanup tests.
4. Update the Codex skill, README, wiki reference/guides/catalog, and automation guidance; release
   as an additive feature with an explicit `tui` command.

Rollback is a package downgrade or avoiding the no-subcommand UI by running an existing subcommand.
No project/global manifests, locks, library files, or target directories are migrated merely by
opening the UI.

## Open Questions

- Confirm the exact maintained Ink package/version pair that supports Node.js 22 and does not add
  native build requirements before locking the dependency in `package.json`.
- Decide whether the initial UI release should expose an explicit offline toggle, or direct users to
  the existing `status --offline`/`sync --offline <revision>` commands until a safe revision-picker
  design is specified.
