## ADDED Requirements

### Requirement: Human results are concise and actionable
Every public command SHALL have a command-specific human renderer that reports the operation mode,
scope, selected library revision and freshness, affected IDs and paths, conflicts or backups, final
state, and a relevant next step without exposing internal result objects.

#### Scenario: Mutation succeeds
- **WHEN** a human-mode mutation changes state
- **THEN** output briefly states what changed, where it changed, the resulting revision, and how to
  inspect or reverse the result

#### Scenario: Preview finds no changes
- **WHEN** dry-run or check mode has no applicable writes
- **THEN** output says the selected scope is current and does not print a raw JSON object

#### Scenario: A new project has no managed state yet
- **WHEN** `status` runs before either project state file has been created
- **THEN** it succeeds with an explicitly discriminated empty managed-state summary
- **AND** it points to `init` when no library is configured, otherwise to `list` and `install`
- **AND** the absence of only one state file remains an integrity failure

#### Scenario: Catalog or managed state is inspected
- **WHEN** a human runs `list`, `info`, `status`, or `diff` in project or global scope
- **THEN** output labels the selected scope, library revision, freshness, and relevant item or state
  counts before showing details
- **AND** catalog, inventory, managed-skill, and difference lists use documented display bounds,
  report omitted counts, and end with a scope-correct next action
- **AND** stale `list`, `info`, or `diff` results direct the user to retry when remote access is
  available without suggesting a mutation or an unsupported `--offline` option
- **AND** JSON mode retains the complete structured result

#### Scenario: Configuration is inspected or changed
- **WHEN** a human runs `config path`, `config list`, `config get`, `config set`, or `config unset`
- **THEN** output labels the active configuration path and distinguishes persisted configured values
  from effective values and their sources where applicable
- **AND** the result ends with a relevant next command rather than exposing an internal result object
- **AND** empty arrays display as `<none>`, while an absent override displays as `<unset>` and does
  not suggest another unset

#### Scenario: A new global scope has no managed state yet
- **WHEN** online or offline `status --global` runs before either global state file has been created
- **THEN** it succeeds before library or cache resolution, performs no state write, and returns an
  explicitly discriminated `managed: false` global summary with `operation: "status"`, state
  directory, empty skills, and the applicable exact `nextAction`
- **AND** it points to both exact `init` routes when no library is configured, otherwise to
  `list --global` and global install
- **AND** the presence of either global state file retains normal state and library validation

#### Scenario: Partial result occurs
- **WHEN** independent skills produce a documented partial result
- **THEN** output separates applied, skipped, failed, and recovery-required entries and gives the
  next safe command

#### Scenario: Initialization finds incompatible nonempty content
- **WHEN** `init` validates a reachable nonempty repository that is not a skill-sync library
- **THEN** the validation error states that remote contents and saved library configuration remain
  unchanged and points to a compatible library, an empty repository, or the exact create command
- **AND** it does not claim the validation cache was unchanged

### Requirement: Discovery recovery is conservative
`show` SHALL be a declarative read-only alias for `info` and SHALL retain the `info` command identity
in structured output. For a syntactically valid unknown selector, discovery MAY return no more than
three deterministic closest exact IDs, each with edit distance at most 2 and similarity at least
60%, but SHALL NOT resolve the selector automatically. Human `info` failures SHALL print only
scope-correct exact `info` retries or a scope-correct `list` fallback. JSON SHALL preserve structured
candidates. Every mutation SHALL fail closed on selector errors without selecting a candidate or
reconstructing a fuzzy mutation command.

#### Scenario: Declarative show alias is used
- **WHEN** a user runs `show <id>` in project or global scope
- **THEN** the CLI executes the same read-only contract as `info <id>`
- **AND** JSON identifies the command as `info`

#### Scenario: Unknown valid selector has conservative candidates
- **WHEN** a syntactically valid selector has no exact or unambiguous match
- **THEN** discovery may return at most three deterministic closest exact IDs that meet both the
  distance and similarity thresholds
- **AND** it reports failure without selecting any candidate

#### Scenario: Human info selector recovery is rendered
- **WHEN** human `info` fails with one candidate, multiple ambiguity choices, or no candidate
- **THEN** it respectively prints one scope-correct exact `info` retry, each scope-correct exact
  `info` choice, or the scope-correct `list` fallback

#### Scenario: JSON info selector recovery is rendered
- **WHEN** JSON `info` fails with advisory candidates
- **THEN** the structured selector errors retain those candidates without adding human `Next:` text

#### Scenario: Mutation receives a typo candidate
- **WHEN** install or another mutation receives a selector for which discovery can suggest an exact
  ID
- **THEN** the whole mutation selection remains unresolved, no write occurs, and no fuzzy mutation
  command is printed

### Requirement: Long operations show safe progress
Interactive human mode SHALL emit prompt progress within a short interval for remote and large
filesystem work. Progress SHALL use stderr, remain phase-oriented, and be disabled for JSON,
`--quiet`, non-TTY output, and completion.

#### Scenario: Remote refresh takes time
- **WHEN** a TTY command waits on a library refresh
- **THEN** the user sees bounded phase progress that clears or resolves into the final result

#### Scenario: Command is piped
- **WHEN** stdout or stderr is noninteractive or `--quiet` is set
- **THEN** no animation or control sequence is emitted

#### Scenario: Verbose diagnostics are requested
- **WHEN** `--verbose` is set
- **THEN** the CLI emits redacted phase and timing detail without exposing credentials or file bodies

### Requirement: Help teaches complete workflows
Top-level help SHALL group commands by lifecycle, setup, discovery, project/global management,
library management, recovery, and diagnostics. Leaf help SHALL show only applicable inherited
options plus valid values, examples, safety notes, and a direct documentation link.

#### Scenario: Install help is requested
- **WHEN** the user runs `skill-sync install --help`
- **THEN** help includes scope, JSON, input, target, gitignore, dry-run, offline, examples, and safety
  behavior

#### Scenario: Invalid choice is passed
- **WHEN** a known-value option such as target, source target, state, shell, or visibility is invalid
- **THEN** parsing reports valid choices before any library refresh

#### Scenario: Similar command is mistyped
- **WHEN** a command or option has a single safe close match
- **THEN** the usage error suggests the intended spelling without executing it

#### Scenario: A first-run setup command is guessed
- **WHEN** the user enters top-level `setup` or `create`
- **THEN** the usage error points to the applicable exact `init` command instead of an unrelated
  spelling match
- **AND** recovery, configuration, cache, project, and network I/O has not started

### Requirement: Shell completion is available
The CLI SHALL generate completion definitions for Bash, Zsh, Fish, and PowerShell. Static completion
SHALL cover commands, options, and choices; dynamic completion SHALL use only verified local cache
and project state and SHALL never prompt, mutate, or access the network.

#### Scenario: Zsh completion is generated
- **WHEN** the user runs `skill-sync completion --shell zsh`
- **THEN** stdout contains a deterministic completion script and no unrelated output

#### Scenario: Skill IDs are completed
- **WHEN** a shell requests dynamic selector candidates
- **THEN** the helper returns locally available qualified IDs within its time budget or returns no
  candidates without an error prompt

### Requirement: Bare invocation behaves by terminal capability
Bare invocation in an interactive supported terminal SHALL open the TUI. Bare invocation in a
noninteractive terminal SHALL print concise help and exit successfully rather than attempting and
failing to launch the TUI.

#### Scenario: Bare command is piped
- **WHEN** stdin or stdout is not a TTY and no command is supplied
- **THEN** the CLI prints setup, discovery, and install examples and exits successfully without
  performing configuration, filesystem, or network I/O
- **AND** explicit `--json` produces the same quick start in one versioned JSON envelope
- **AND** conflicting scope options fail with usage status instead of bypassing validation

### Requirement: TUI reviews application-equivalent plans
The TUI SHALL provide first-run library setup and doctor paths, derive reviews from the same dry-run
planner as the CLI, respect configured target and gitignore defaults, and apply only after explicit
confirmation. Project and global dashboards SHALL honor a valid effective configured target set and
fall back to Codex only when no valid target set is available. If the plan changes before
commit, the TUI SHALL require a fresh review.

#### Scenario: Dashboard initializes install targets
- **WHEN** a user opens either a project or global dashboard with a valid effective configured
  target set
- **THEN** the TUI initializes its install target selection from that complete set
- **AND** when no valid target set is available, it selects Codex as the fallback

#### Scenario: First-run TUI has no library
- **WHEN** an interactive user launches the TUI without a configured library
- **THEN** it offers connect, create, doctor, documentation, and exit actions instead of a dead-end
  list/status error
- **AND** the create action explicitly identifies that the new library starts empty

#### Scenario: First-run setup finds a populated library
- **WHEN** setup succeeds and the loaded library contains skills
- **THEN** the TUI opens the catalog and tells the user to press Space to select a skill and `i` to
  review installation

#### Scenario: First-run setup finds an empty library
- **WHEN** connect or create setup succeeds and the loaded library contains no skills
- **THEN** the TUI remains on the overview
- **AND** it tells the user to exit, run exactly `skill-sync add <path> --dry-run`, and reopen
  skill-sync

#### Scenario: Catalog has no visible skills
- **WHEN** the selected library itself contains no skills
- **THEN** the catalog identifies the empty library and gives the exact
  `skill-sync add <path> --dry-run` preview handoff

#### Scenario: Catalog filter has no matches
- **WHEN** skills exist but the current search and group filter have no matches
- **THEN** the catalog identifies the filtered result and does not suggest adding a skill

#### Scenario: First-run diagnostics complete with findings
- **WHEN** the TUI receives a structured doctor success or failure report
- **THEN** it shows pass, warning, fail, and skipped counts without printing raw JSON
- **AND** it orders failures before warnings and skipped checks, displays remediation as `Next:`,
  bounds long issue lists to the terminal with a visible-range indicator, and offers rerun and back
  controls

#### Scenario: Recovery blocks a novice workflow
- **WHEN** startup inspection or a mutation reports unresolved recovery evidence
- **THEN** the first suggested command is the runnable `recovery list`, followed by
  `recovery inspect <id>` and preview-first resume or restore guidance
- **AND** list and inspect remain scope-agnostic while inspection identifies affected destinations
  and shows `--project <path>` placement on project-owned resume, restore, or prune actions
- **AND** human list, inspect, resume, restore, and prune results explicitly identify read-only,
  preview, complete, or idempotent state; translate recovery actions into plain language; bound
  records, destinations, and owned paths to 20 with omitted counts; and end with the next safe action
- **AND** JSON results retain their complete existing structures

#### Scenario: Install is reviewed
- **WHEN** the user selects skills and targets
- **THEN** the TUI displays the exact destinations, ignore-file changes, revision, conflicts, and
  writes from a dry-run plan before enabling confirmation

#### Scenario: A standalone install preview hands off the exact apply command
- **WHEN** a standalone human `install --dry-run` produces a nonempty project or global plan
- **THEN** its final `Next:` line is a complete apply command containing the resolved exact
  qualified skill IDs or the original `--all` selection, deterministically sorted repeated targets,
  the resolved project gitignore policy when applicable, the selected scope, and
  `--expect-plan <fingerprint>`
- **AND** an explicit project selection uses `--project <project-path>` backed by the labeled project
  path instead of interpolating a filesystem path into executable shell guidance

#### Scenario: A reviewed CLI install is applied
- **WHEN** a user passes the fingerprint from `install --dry-run` through `--expect-plan`
- **THEN** installation applies only when revision, scope, destinations, original content, state,
  ignore-file delta, and writes still match
- **AND** a mismatch performs no staging, journaling, or destination writes and requires a new
  preview
- **AND** ordinary installs without `--expect-plan` remain compatible

#### Scenario: TUI plan changes
- **WHEN** revalidation finds a different revision, digest, destination, or write set
- **THEN** the TUI returns to review and does not apply through an unconditional yes flag

### Requirement: Terminal presentation remains accessible
Human and TUI output SHALL work with `NO_COLOR`, narrow terminals, Unicode-disabled environments,
screen readers or plain text capture, and cancellation keys without losing semantic status.

#### Scenario: Color is disabled
- **WHEN** `--no-color` or `NO_COLOR` is active
- **THEN** labels and text preserve every status conveyed by color
