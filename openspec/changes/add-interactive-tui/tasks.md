## 1. Establish the TUI boundary and entry points

- [x] 1.1 Confirm and add a Node.js 22-compatible Ink renderer/test-renderer dependency, documenting
  the package-size and non-native-build check.
- [x] 1.2 Define injectable terminal-runtime, UI action, and scope-aware dashboard interfaces under
  `libs/cli/src/ui/tui/` so application/domain code is independent of the renderer.
- [x] 1.3 Add the explicit `tui` command and no-subcommand interactive routing while preserving all
  existing subcommand parsing and forwarding project/global scope options to the UI entry point.
- [x] 1.4 Gate TUI startup on interactive input/output and reject `tui` requests with `--json`,
  `--no-input`, or non-TTY streams using a clear usage result without ANSI output.
- [x] 1.5 Add CLI dispatch tests for bare interactive launch, explicit TUI launch, non-interactive
  rejection, `--json` preservation, and the unchanged existing top-level command surface.

## 2. Build safe scope-aware read models

- [x] 2.1 Stabilize or consume the resolved managed-scope abstraction from the global-skill change
  so project remains default, global is explicit, and the UI never infers scope from a target path.
- [x] 2.2 Create a dashboard query that combines catalog summaries, target availability, and managed
  reconciliation status without invoking mutations or parsing human-formatted command output.
- [x] 2.3 Implement the bounded unmanaged-skill scanner using only supported target roots, direct
  candidate directories, and existing safe skill-directory validation.
- [x] 2.4 Associate inventory records with normalized selected-scope manifest/lock projections and
  model managed, unmanaged, invalid-candidate, inaccessible-path, and invalid-state outcomes
  explicitly.
- [x] 2.5 Add unit tests for group/status dashboard projections and unmanaged inventory association,
  including valid untracked paths, tracked paths, invalid candidates, unreadable paths, corrupt
  state, and a valid-looking skill outside target roots.

## 3. Implement the terminal workflow

- [x] 3.1 Implement a renderer-independent navigation state machine for overview, group browsing,
  search, skill details, multi-select, target selection, install review, managed status, unmanaged
  inventory, help, error, back, and quit transitions.
- [x] 3.2 Render accessible standard and compact layouts with focus indicators, keyboard help,
  installation/reconciliation status badges, no-color support, and guaranteed terminal cleanup.
- [x] 3.3 Connect catalog browsing, filtering, details, selection, and target eligibility to the
  dashboard read model without side effects.
- [x] 3.4 Add an installation review that shows scope, IDs, targets, and planned changes, then calls
  the existing typed install workflow only after user confirmation and presents its result.
- [x] 3.5 Add managed-skill inspection and sync/update review screens that call the shared
  reconciliation workflow; require an explicit discard-local control plus confirmation before any
  replacement of local edits.
- [x] 3.6 Add the informational unmanaged-skills screen and ensure its view/open/refresh/exit paths
  cannot alter state, target contents, `.gitignore`, or library content.

## 4. Verify user-visible safety and behavior

- [x] 4.1 Add controller and renderer tests with the TUI test runtime for keyboard navigation,
  search, selection, review cancellation, success/failure recovery, compact layout, and cleanup.
- [x] 4.2 Add integration coverage proving confirmed UI actions reuse normal install/reconciliation
  preflight, collision, conflict, backup, and local-edit safeguards instead of bypassing them.
- [x] 4.3 Add project- and global-scope fixtures (after global scope is available) that verify target
  inventory boundaries and show untracked existing Codex/Claude skills without adopting them.
- [x] 4.4 Run the focused unit/integration/e2e suites and package smoke test; resolve regressions in
  argument-driven command behavior before widening checks.

## 5. Synchronize documentation and release checks

- [x] 5.1 Update `skills/skill-sync/SKILL.md` with terminal entry conditions, navigation workflow,
  scope selection, unmanaged-inventory safety semantics, and the argument-driven automation
  fallback.
- [x] 5.2 Update `README.md`, wiki getting-started and project workflow guides, command reference,
  automation guidance, and `apps/wiki/src/data/commands.ts` for `tui` and the bare interactive
  workflow; keep command/option names and safety examples aligned.
- [x] 5.3 Search `README.md`, `skills/skill-sync/SKILL.md`, and `apps/wiki/src/` for affected command
  terms and correct stale references.
- [x] 5.4 Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
  `npm run wiki:build`, and `npm run check`; record any intentionally deferred global-scope
  integration dependency.
