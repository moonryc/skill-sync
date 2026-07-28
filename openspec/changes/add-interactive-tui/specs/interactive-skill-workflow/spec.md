## ADDED Requirements

### Requirement: Interactive terminal entry points preserve command automation
The system SHALL provide an explicit `skill-sync tui` command and SHALL launch the same interactive
interface for an invocation with no subcommand only when standard input and standard output are
interactive terminals and neither `--json` nor `--no-input` is set. The system MUST preserve the
existing behavior and output contract of every invocation that contains an existing subcommand.
The system MUST refuse a TUI request made with redirected input/output, `--json`, or `--no-input`
with a usage error that suggests argument-driven commands, without rendering terminal control
sequences or starting a prompt.

#### Scenario: Bare command opens the terminal interface
- **WHEN** a user runs `skill-sync` in an interactive terminal without `--json` or `--no-input`
- **THEN** the system opens the interactive skill workflow instead of requiring a subcommand

#### Scenario: Existing argument-driven command remains machine-readable
- **WHEN** automation runs `skill-sync --json list --group frontend`
- **THEN** the system executes the existing `list` workflow and emits its single JSON result without
  launching the terminal interface

#### Scenario: Explicit TUI command cannot run non-interactively
- **WHEN** a user runs `skill-sync tui --no-input` or pipes output from `skill-sync tui`
- **THEN** the system returns a usage error and does not enter full-screen terminal mode

### Requirement: Users can browse the grouped catalog and plan an installation
The interactive workflow SHALL display a scope-labelled overview and allow a user to navigate
hierarchical library groups, filter skills by qualified ID or description, inspect a skill's summary
and installation state, and select one or more eligible skills. It SHALL let the user choose valid
agent targets and present a review containing selected IDs, targets, scope, and planned changes
before any installation request. The workflow MUST remain read-only until the user accepts that
review.

#### Scenario: User filters a skill within nested groups
- **WHEN** a user enters a search query while browsing the library catalog
- **THEN** the interface shows matching skills across groups with their qualified IDs, descriptions,
  compatible agents, and current installation-state badges

#### Scenario: User confirms a multi-skill installation
- **WHEN** a user selects multiple eligible skills and targets and accepts the installation review
- **THEN** the system submits the equivalent existing installation workflow with those IDs and
  targets and displays its structured success, conflict, or failure result

#### Scenario: User leaves an installation review
- **WHEN** a user returns from or quits an installation review without accepting it
- **THEN** the system makes no installation or target-directory changes

### Requirement: Users can inspect and explicitly reconcile managed skills
The interactive workflow SHALL show managed-skill reconciliation state for the selected scope,
including current, outdated, locally modified, conflicted, missing, orphaned, and collision states.
It MUST NOT synchronize a skill merely by opening or refreshing the screen. A reconciliation action
MUST use the existing shared workflow and require explicit review/confirmation; replacement of
local edits MUST require the same explicit discard-local choice and confirmation as the
argument-driven command.

#### Scenario: Dashboard shows a local modification without replacing it
- **WHEN** a tracked installed skill differs from its recorded base
- **THEN** the managed-skills screen marks it as locally modified and does not change it

#### Scenario: User performs a normal safe sync
- **WHEN** a user reviews and confirms synchronization for reconcilable tracked skills without
  enabling local replacement
- **THEN** the system invokes the existing safe synchronization workflow and reports its result

#### Scenario: User declines local-edit replacement
- **WHEN** a locally modified skill would require discard-local and the user does not explicitly
  enable and confirm that option
- **THEN** the interface does not replace the local files

### Requirement: Terminal sessions are navigable and recoverable
The interface SHALL provide keyboard navigation for focus, selection, activation, back, help, and
quit actions; it SHALL provide a readable compact layout when the terminal cannot fit its normal
multi-pane layout. It MUST restore terminal state when the user exits, cancels, or an unexpected
error occurs. It SHALL show workflow and inventory errors as structured, recoverable screen content
rather than treating untrusted skill-file contents as terminal instructions.

#### Scenario: User exits from a top-level screen
- **WHEN** a user invokes the quit action from a top-level terminal screen
- **THEN** the interface cleans up its terminal session and returns control to the shell without
  changing skills

#### Scenario: A workflow operation fails
- **WHEN** an installation or reconciliation workflow returns an error
- **THEN** the interface displays the error and allows the user to return to a safe screen or quit

#### Scenario: Terminal is too narrow for the standard layout
- **WHEN** the renderer detects that the terminal cannot display the standard multi-pane layout
- **THEN** the interface uses a readable compact layout with the same available actions
