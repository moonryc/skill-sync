## Why

The existing command-oriented interface is precise and automation-friendly, but it asks newcomers
to memorize command names, qualified IDs, and flags before they can browse a library or understand
their project's skill state. An interactive terminal interface can make the common discovery,
installation, and synchronization workflows approachable without weakening the current scriptable
CLI contract.

## What Changes

- Launch a full-screen, keyboard-driven terminal UI for an interactive invocation with no command,
  while retaining every existing command, argument, option, JSON result, and non-interactive mode.
- Let users browse hierarchical library groups, search and inspect skills, select multiple eligible
  skills, choose applicable targets, review a plan, and install through the existing safe workflow.
- Provide a project/global scope-aware dashboard for managed-skill state, with actions to inspect,
  refresh, and safely reconcile tracked skills using the current conflict and confirmation rules.
- Discover valid skill directories already present in supported agent directories that are not
  represented by the selected scope's manifest/lock state, and show them as unmanaged rather than
  silently adopting, replacing, or deleting them.
- Add a visible non-interactive fallback and an explicit way to launch the UI so automation, pipes,
  CI, `--json`, and `--no-input` remain deterministic.
- Document the interactive workflow alongside the argument-driven command reference.

## Capabilities

### New Capabilities

- `interactive-skill-workflow`: Provide a navigable terminal interface for catalog discovery,
  multi-skill installation, tracked-skill reconciliation, and safe handoff to existing operations.
- `unmanaged-skill-discovery`: Inventory valid agent skill directories within the selected scope
  and report skills that exist on disk but are not managed by `skill-sync`.

### Modified Capabilities

None. Existing argument-driven commands retain their current public behavior and output contracts;
the terminal UI is an additive interactive entry point.

## Impact

- Affects command dispatch, terminal/TTY capability detection, interactive presentation code,
  catalog and reconciliation read models, target scanning, and installation/reconciliation command
  adapters in `libs/cli/`.
- Adds a maintained terminal UI rendering dependency and terminal-focused tests, while preserving
  the current Node.js 22 baseline.
- Requires updates to the `skill-sync` Codex skill, README, wiki guides/reference, command catalog,
  and automation documentation so users know when to use the UI versus flags.
- The work must integrate with the in-progress global-skill scope so a user can clearly choose and
  see the project or global managed scope; it must not rely on current-directory inference to make
  that choice.
