---
name: skill-sync
description: Use the @moonryc/skill-sync npm CLI to manage a Git-backed library of reusable AI skills and safely project selected skills into Codex or Claude projects. Trigger when the user asks to install, adopt, configure, inspect, update skills or the CLI, publish, uninstall, validate, or troubleshoot skill-sync.
---

# skill-sync

Use the `skill-sync` command-line tool; it is not a JavaScript API. Run commands from the target project unless `--project <path>` is supplied. Use the explicit, mutually exclusive `--global` flag for user-level Codex or Claude skills.

## Setup

Install Node.js 22+ and Git, then install the package globally:

```sh
npm install --global @moonryc/skill-sync
skill-sync version
```

Connect an existing library:

```sh
skill-sync init git@github.com:<owner>/<repo>.git --dry-run
# Apply only with the exact --expect-plan command printed by the preview.
```

Or create a private GitHub library with the GitHub CLI:

```sh
gh auth login
skill-sync init --create <owner>/<repo> --transport ssh --dry-run
# Apply only with the exact --expect-plan command printed by the preview.
```

Use Git credential helpers, SSH, or `gh` for authentication. Never put credentials in a remote URL.
`init --dry-run` validates the exact repository, branch, effects, and current user configuration
in disposable OS-temporary storage. It does not write the persistent cache or configuration.
Apply the printed `init-v1-...` fingerprint with `--expect-plan`; if the repository or
configuration changed, `INIT_PLAN_CHANGED` prints an exact new preview command and requires another
review. Apply rechecks the selected branch before any persistent cache write, then promotes the
already validated exact commit from disposable storage instead of fetching an unreviewed revision.
Keep this explicit preview-first workflow as the default. A direct `skill-sync init ...` with no
`--dry-run`, `--expect-plan`, or `--yes` still plans before applying. In an interactive human
terminal, it prints the plan and asks whether to apply it. When confirmation is unavailable because
of `--no-input`, `--json`, CI, or redirected streams, it returns the preview without setup changes.
`--expect-plan` applies the reviewed fingerprint; explicit `--yes` is the intentional one-command
automation opt-in that plans and applies without a prompt.
The first-run TUI uses this same plan/apply path and never invents a separate setup result.
Real `init`, `config set`, and `config unset` commands share a crash-visible user-configuration
lock across processes. On `ADVISORY_LOCK_UNAVAILABLE`, wait for the active setup/config command; if
none is active, inspect `skill-sync recovery list`. A dry-run setup preview does not take that lock.
If `init` returns `REMOTE_ACCESS_FAILED`, use its short sanitized Git reason and transport-specific
next step: configure a credential helper or provider login for HTTPS, or check the loaded key and
host configuration for SSH. When connecting an existing remote, the failed probe does not persist
configuration, cache, staging, or project state. With `init --create`, authentication and name
availability are checked first. If a later initialization step fails, local state is still
not proof of what happened at the provider. skill-sync records provider creation, initial push,
and saved-configuration phases as inspect-only recovery evidence. The repository or pushed commit
may already exist, and skill-sync never automatically replays or deletes those external changes.
If `init` returns `INCOMPATIBLE_LIBRARY` for a reachable nonempty repository, preserve the reported
boundary: remote contents, persistent cache, and saved library configuration were unchanged.
Choose an already compatible library, use an empty repository, or
preview a new one with `skill-sync init --create <owner/name> --dry-run`; never reinitialize the
nonempty remote.

Use `skill-sync --help` for the categorized command map and
`skill-sync <command> --help` for that leaf's accepted arguments, choices,
scope flags, runnable examples, safety note, and wiki link. These help sections
and the parser come from the same typed command registry. Do not retry by
silently dropping an invalid option: unsupported scopes, invalid choices, and
conflicts are rejected before command I/O with an actionable usage error.
Treat top-level `setup` and `create` as mistaken invocations, not aliases. They
return `USAGE_ERROR` with status `2` before recovery or command I/O and point
exactly to `skill-sync init <repository-url> --dry-run` and
`skill-sync init --create <owner/name> --dry-run`, respectively. Other single safe typos
continue to receive a spelling suggestion and are never executed automatically.

Generate deterministic static shell completion with the exact required shell
choice `bash`, `zsh`, `fish`, or `powershell`. For the current session:

```sh
# Bash
source /dev/stdin <<< "$(skill-sync completion --shell bash)"

# Zsh, after compinit is initialized
source <(skill-sync completion --shell zsh)

# Fish
skill-sync completion --shell fish | source
```

For PowerShell:

```powershell
skill-sync completion --shell powershell | Out-String | Invoke-Expression
```

Without `--json`, stdout is only the sourceable script. With `--json`, read the
`{ shell, script }` object inside the versioned result's data. Completion
generation does not read or write configuration, cache, project, global, or
profile state, inspect recovery evidence, contact the network, or edit shell
startup files. For persistence, save the generated script in the shell's user
completion directory and add a profile source line manually only when the user
requests it; regenerate the saved file after a CLI update.

## Core workflows

For an interactive terminal session, use the command center instead of
memorizing selectors and options:

```sh
skill-sync
# or
skill-sync tui
```

The TUI lets users browse groups, search, select skills/targets, inspect managed
state, and view valid untracked skills in supported Codex/Claude target roots.
For project and global dashboards, initialize selected targets from the effective
`defaults.targets` value. Honor a valid configured set in either scope and use Codex
as the fallback only when no valid target set is available.
Before a library is configured, it offers connect, create, and diagnostic
actions plus a read-only setup-guide screen rather than trying to render an
empty catalog. The create action explicitly says `Create GitHub library (starts empty)`.
Connect URLs and create `owner/name` values are validated inline;
invalid input remains editable beside a safe example, and embedded credentials
receive specific removal guidance. Valid input opens a separate review and only
`y` invokes setup. Connect review shows the normalized credential-free URL,
cache/configuration effects, and the empty-remote follow-up; create review identifies the private HTTPS `main`
repository, external creation and push, plus the possibility that the repository
remains after a later failure. Esc returns to the editable form. Setup always
configures the user-wide library, even from a `--project` or `--global` dashboard;
never forward either scope selector to `init`. A bare noninteractive invocation
prints a write-free setup preview → exact apply → `list` → `install` quick start; use explicit
argument-driven commands for automation.
After setup, a populated library opens the catalog and teaches `Space` to select a skill and `i` to
review installation. An empty library stays on the overview and gives the exact write-free author
handoff `skill-sync add <path> --dry-run`. In the catalog, distinguish a truly empty library from a
search or group filter with no matches: only the truly empty state gives the add preview, while the
filtered state says that no skills match the current search and group filter.
An adoptable entry can be paired with a deliberately selected exact qualified
library ID and reviewed; adoption tracks only a byte-for-byte canonical match and
never replaces target files. The screen remains read-only until a reviewed action
is accepted. It cannot be used with `--json`, `--no-input`, `--yes`, redirected
streams, or CI; those input and machine flags are omitted from TUI help and
rejected before I/O. Use the explicit commands below for deterministic
automation. Do not describe an unmanaged skill as tracked merely because it is
displayed.

The install review uses `install --dry-run` and exposes the selected revision,
freshness, destinations, state writes, and actual `.gitignore` change. Target
or policy changes refresh the plan. Confirmation repeats the preview and returns
to review if its full fingerprint changed; a matching plan is applied with that
exact fingerprint.
Long TUI lists use cursor-aware windows, so the highlighted item remains the one
acted on.

The TUI diagnostics screen parses the structured `doctor` report from either a
successful or failed command result. Read the pass, warning, fail, and skipped
counts first; failures are listed before warnings and skipped checks, with each
remediation labeled `Next:`. Long issue lists are terminal-bounded and report
their visible range. Use `r` to rerun diagnostics or Enter/Esc to return. Do not
interpret or expose a raw JSON object from this screen.

When a newer stable CLI release is available, the TUI displays a quiet footer
indicator with the installed and available versions. It does not interrupt TUI
work. After leaving the TUI, update the global npm installation explicitly:

```sh
skill-sync self-update
```

`self-update` updates the CLI package only; use `sync` or `update` to refresh
managed skills. `skill-sync version` (or `skill-sync --version`) prints the
installed CLI version without accessing project state or the npm registry.

Discover available skills before choosing a selector:

```sh
skill-sync list
skill-sync list --query <term>
skill-sync info <group>/<skill>
skill-sync show <group>/<skill>
```

In human mode, `list` and `info` label scope, library identity, revision, and
freshness before the catalog data. `list` reports all matches but displays at
most 20; `info` reports all files but displays at most 25. Both name omitted
items and finish with a runnable `Next:` command. For an uninstalled skill, the
next action is a complete preview command: prefer `codex` when compatible,
otherwise use `claude`; include `--gitignore` for project scope, omit it for
global scope, and always include `--dry-run`. Do not emit a next command that
will immediately fail for an omitted target or gitignore policy. If cached data
is stale, the action is instead to retry when remote access is available; do not
suggest an install or invent an unsupported `--offline` option. JSON mode
retains the complete structured result.
After a canonical skill ID validates, its human next action routes through
`skill-sync info <qualified-id>` to obtain compatibility and the complete
preview command; do not replace that with an incomplete install suggestion.
Validation guidance must also preserve subject and scope: after a failed
explicit selector/path, rerun `validate <same-id-or-path>`, not bare `validate`;
catalog, canonical-ID, and installed-copy handoffs retain `--global` or
`--project <project-path>` when selected. JSON output remains unchanged.
`show` is the declarative read-only alias for `info`; JSON still attributes it
to `info`. For a syntactically valid unknown selector, discovery may return at
most three deterministic closest exact IDs, each within edit distance 2 and the
60% similarity floor. Never treat a candidate as a resolution. Human `info`
guidance retries a single candidate with a scope-correct exact `info` command,
lists scope-correct exact `info` choices for ambiguity, or uses the scope-correct
`list` fallback when there is no conservative candidate. JSON preserves the
structured candidates. Every mutation must fail with an empty selection on any
selector error; do not reconstruct or recommend a fuzzy mutation command.

Install a skill into the current project. Repeat `--target` for both agents and use `--gitignore` when managed copies should be ignored:

```sh
skill-sync install <group>/<skill> --target codex --target claude --gitignore --dry-run
# Apply only with the exact --expect-plan command printed by the preview.
```

Preview the complete plan; standalone human output supplies the exact fingerprint-bound apply
command. Its shape is:

```sh
skill-sync install <group>/<skill> --target codex --gitignore --dry-run
skill-sync install <group>/<skill> --target codex --gitignore --expect-plan <fingerprint>
```

For a standalone human preview with changes, copy its complete `Next: skill-sync ...` line instead
of reconstructing the apply. Skill-sync builds that handoff from the resolved exact qualified IDs
or the original `--all` selection, deterministically sorted repeated `--target` flags, the resolved
project `--gitignore` or `--no-gitignore` policy when applicable, project/global scope, and the
exact fingerprint. When the invocation used an explicit project, the command deliberately keeps
`--project <project-path>`; substitute the labeled project path from the preview rather than
interpolating an untrusted path into shell guidance.

The `install-v1-...` fingerprint binds revision, scope, destinations, existing
content, resulting state, `.gitignore` delta, and writes. If anything changed,
the apply returns `INSTALL_PLAN_CHANGED` without staging, journaling, or changing
managed content or state; preview again. Never combine `--dry-run` with
`--expect-plan`.

A direct `install` with neither `--expect-plan` nor explicit `--yes` still plans before applying.
In an interactive human terminal, it prints the complete plan and asks whether to apply it. When
confirmation is unavailable because of `--no-input`, `--json`, CI, or redirected streams, it
returns a verified cache-only preview and makes no project or global writes. `--expect-plan`
applies the reviewed fingerprint; explicit `--yes` is the intentional one-command automation
opt-in. Always supply selectors, targets, scope, and the project `.gitignore` policy explicitly in
automation.

An install preview rendered inside an already-running interactive apply tells
the user to confirm that current prompt; it must not tell them to launch a
second command. A standalone `install --dry-run` continues to print the exact
`--expect-plan install-v1-...` apply handoff. If an inline preview has no
changes, return its scope-correct status guidance without prompting or entering
the apply path.

Human install and uninstall previews report scope, library revision and
freshness, destinations, planned writes, `.gitignore` changes, and backup
requirements. Install previews are complete authorization plans: do not bound
or omit their selected skills or destinations. If every selected target is
already installed, the preview directs the user to the scope-correct `status`
command instead of suggesting a no-op `--expect-plan` apply. Completed install
summaries label writes as completed, show at most 20 sorted skills with an
omitted count, and use `skill-sync --global status` after a global install. Do
the same for completed uninstalls: distinguish a created backup from a previewed
requirement and keep retry or verification guidance in global scope when
`--global` was used. Do not treat a stale-cache warning as an authoritative
apply plan; refresh first. JSON mode keeps the complete structured result.
When prompts are unavailable, treat the printed destructive dry-run handoff as
authoritative: it adds `--yes` when canonical/group removal, a recovery action,
or a backup-requiring uninstall would otherwise reject the apply. Interactive
and non-destructive handoffs do not add that flag.

Adopt an already-present copy only when it exactly matches the selected canonical
skill. This writes normal tracking state and never copies, overwrites, or deletes
the target directory:

```sh
skill-sync adopt <group>/<skill> --target codex --dry-run
skill-sync adopt <group>/<skill> --target codex
```

Human adoption output names the existing copy, states that target files are
unchanged, and distinguishes planned from completed tracking writes. A completed
global adoption must end with `skill-sync --global status`, never the project
status command. JSON retains the complete structured result.

Install, inspect, reconcile, or remove a user-level copy without creating
project metadata or changing `.gitignore`:

```sh
skill-sync --global install <group>/<skill> --target codex --dry-run
# Apply only with the exact --expect-plan command printed by the preview.
skill-sync --global adopt <group>/<skill> --target codex
skill-sync --global status
skill-sync --global sync --dry-run
skill-sync --global uninstall <group>/<skill>
```

Global Codex and Claude copies live at `~/.codex/skills/<name>` and
`~/.claude/skills/<name>`. Their intent and lock state live in skill-sync's
user state directory under `global/`; never write project `skill-sync.json`
files into either agent directory. Global operations have the same collision,
symlink, local-edit, backup, confirmation, and dry-run safeguards as project
operations. Do not combine `--global` with `--project`.

Check project state before changing managed copies:

```sh
skill-sync status
skill-sync diff <group>/<skill>
skill-sync sync --check
```

Human project and global `status` output labels scope, freshness, total managed
skills, and per-state counts, then shows at most 20 skills. `diff` labels the
skill state plus target and difference totals and shows at most 25 differences
per target. Human `sync` and `update` output adds selected, outcome, write, and
backup counts, bounds the detail to 20 skills, preserves individual failures,
and ends with a scope-correct action. Omitted counts and the final `Next:` action
are authoritative; JSON retains every result. When an initialized project or
global scope has zero managed skills, `status` points to the scope-correct
`list` command and its complete preview-ready install handoff; do not replace it
with an underspecified `install <id>`. If the original command used `--project`,
human `list`, `info`, install, adopt, uninstall, publish, status, diff, sync,
update, and healthy doctor handoffs retain `--project <project-path>`;
substitute the `Project` or `Scope` path printed in the same result. Never drop
that selector and accidentally act on the caller's current directory. If
freshness is not current, refresh before a mutation. `status` may use
`--offline`; `diff` does not, so
stale diff guidance retries when remote access is available. If `status
--offline` reports that no verified cached revision exists, rerun the same
status command without `--offline` when remote access is available to populate
the cache; do not substitute an unverified directory.

For `orphaned`, do not recommend `sync`: reconciliation always skips a skill
that no longer exists canonically. Preview `skill-sync uninstall <id> --dry-run`
with the same project/global selector, or restore the canonical skill to the
library. Status, diff, and skipped reconciliation output now give that exit
path directly.

When both global state files are absent, `status --global` succeeds online or
with `--offline` before library/cache resolution and without creating state. Its
structured result has `managed: false`, global scope, `stateDirectory`, an empty
`skills` array, `operation: "status"`, and `nextAction`. That action is
`skill-sync init <repository-url> --dry-run` when unconfigured and
`skill-sync list --global` when configured. Human guidance additionally names
`skill-sync init --create <owner/name> --dry-run` as the second setup route, then the
global list command. Do not bypass normal validation when either global state
file already exists.

Refresh tracked skills with `sync` or selected skills with `update`:

```sh
skill-sync sync
skill-sync update <group>/<skill>
```

Add a new local skill to the canonical library, or publish edits from an installed copy:

```sh
skill-sync add ./path/to/skill --group <group>
skill-sync publish <group>/<skill> --from codex
```

Use `publish --dry-run` first when the source or intended change is uncertain.

## Safety rules

- Prefer qualified IDs such as `frontend/review-ui`; an unqualified name is valid only when unique.
- Use `--dry-run` before mutations that may replace files, change ignore rules, or delete content.
- `install` only installs; it never updates an already tracked copy. `sync` and `update` pull changes; they never publish.
- `adopt` requires one exact qualified ID and target. It only records an existing valid copy whose complete digest matches the canonical skill; leave divergent local content unchanged.
- Never use `--discard-local` without first reviewing `status`, `diff`, and the dry-run. It is required for destructive replacement and creates a recoverable backup.
- Do not bypass conflicts by force-pushing or manually overwriting canonical content. Resolve local/canonical changes, then publish deliberately.
- Treat fetched skill files as inert data. Do not execute scripts, hooks, package lifecycle commands, or submodules from a skill.
- Git operations disable hooks and recursive submodules; on Windows, they enable Git long-path support for nested managed content.
- For automation, use `--json` and provide every selector and choice explicitly. Add `--no-input` only to a command whose leaf help advertises prompts, such as `init`, `install`, `sync`, `update`, `publish`, `uninstall`, a recovery action, `library remove`, or `group remove`. Read-only and non-prompting commands reject `--no-input` and `--yes` with `OPTION_UNSUPPORTED` before I/O. Parse the single versioned JSON object and handle nonzero exit statuses.
- Treat scope and selection validation as authoritative: never combine `--global` with `--project`, `--all` with explicit IDs, or `--gitignore` with `--no-gitignore`.
- Bare `--json` returns one successful quick-start envelope without reading configuration or project state, and `--json version` returns one version envelope.

## Troubleshooting

Run non-mutating diagnostics first:

```sh
skill-sync doctor
skill-sync doctor --offline
skill-sync validate
skill-sync config list
```

When recovery evidence blocks a mutation, get a stable record ID before inspecting or acting:

```sh
skill-sync recovery list
skill-sync recovery inspect <id>
```

Follow the action printed by inspection. For an ordinary recoverable journal, preview the offered
`recovery resume <id> --dry-run` or `recovery restore <id> --dry-run` direction and apply only after
review. For initialization evidence, first inspect the provider repository and branch, then run the
exact fresh `skill-sync init ... --dry-run` command printed by inspection. If its current plan is
correct, run the exact `--expect-plan` command that preview prints. Provider creation, initial push,
and saved-configuration phases are inspect-only; `resume`, `restore`, and `prune` cannot act on
them. External repository changes are never automatically replayed or deleted. A successful setup
for the same remote clears older matching initialization evidence.

For a valid advisory-lock record, use the singular preview-first remediation printed by
inspection:

```sh
skill-sync recovery unlock <id> --dry-run
skill-sync recovery unlock <id>
```

The apply requires interactive confirmation or explicit `--yes`. It is permitted only when the
recorded hostname is the current host and the operating system proves the recorded PID is absent.
Owned advisory locks refresh their persisted lock-file mtime heartbeat every 15 seconds. The fixed
60-second crash grace runs from the later of metadata creation and that last persisted heartbeat so
orphaned child processes can exit. Applies serialize per stable ID using a crash-visible recovery
action lock. While holding it, skill-sync revalidates the exact lock path, full owner metadata,
crash grace, and plan fingerprint immediately before removing only that lock file. Active,
foreign-host, too-young, malformed, changed, or otherwise unverifiable lock evidence is refused and
preserved. Never delete the lock manually to bypass a refusal.

After unlinking, skill-sync syncs the lock's parent directory before reporting completion. If that
sync is ambiguous, it preserves the recovery action lock as inspectable evidence instead of
claiming clean success. Run `recovery list` again and inspect the remaining record. JSON recovery
inspection and unlock preview output never expose the internal `ownerToken`; treat the displayed
owner fields and fingerprint as the public contract.

`recovery prune <id> --dry-run` is limited to terminal journals and verified backups. Never
manually delete journals, locks, staging paths, or backups, and never attempt to replay legacy
inspect-only evidence.
Run `recovery list`, `recovery inspect`, and `recovery unlock` without `--project` or `--global`;
only list accepts its own `--scope <scope>` filter, while unlock accepts exactly one stable ID and
no scope flag. Human inspection prints affected destinations and adds
`--project <affected-project>` to a project-owned resume, restore, or prune action. Keep that
selector on the action command only. These scope-aware action commands resolve the selected
project or global root to its canonical path before evidence matching, planning,
and locking, so a symlink alias cannot create a second recovery scope.
Human recovery output is bounded at 20 records, destinations, or owned paths and
reports omitted counts. `list` and `inspect` explicitly say they made no changes;
inspection distinguishes recoverable, inspect-only, and cleanup-only evidence.
Unlock output names the exact lock, recorded operation, PID, host, scope,
dead-process-plus-grace proof, and fingerprint. Resume, restore, and prune translate
internal action codes into plain language and end with the scope-correct apply
or verification step. Treat the displayed fingerprint and final `Next:` line
as authoritative; JSON retains the complete structured result. A human preview
produced without prompt capability includes the required `--yes` on its apply
step.

The human doctor report has an overall result, scope and offline context, all
four status counts, and at most 20 failure-first check details with an omitted
count. Visible failure/warning remedies are numbered, and every result ends in
`Next:`—first remedy plus rerun, an online rerun for skipped remote checks, or a
scope-correct `list` when healthy. `--no-color` suppresses ANSI styling;
`--json` retains every structured check. Use `status` to distinguish current,
outdated, locally modified, conflicted, missing, orphaned, and colliding copies.
For offline work, pass an explicit cached commit, for example `sync --offline
<full-commit>`; offline results are stale and must not be described as current.

Doctor always performs a read-only application recovery scan, including in
`--offline`, JSON, and TUI use. Its `Recovery state` check passes when the store
is clean, warns with counts for valid locks, incomplete journals, or backups,
and fails locally for malformed or unsafe evidence. Follow its exact
`recovery list` then `recovery inspect <id>` remediation; doctor never repairs or
deletes the evidence itself.

Human configuration output is deliberately labeled. `config path` names the
active file; `config list` shows the configured-key count and each key's
configured value, effective value, and effective source. `config get`, `set`,
and `unset` show the same fields for one key plus a safe next command. Empty
arrays render as `<none>` and absent overrides as `<unset>`; do not recommend
`config unset` when `config get` says no override exists.

Treat the `changed` and `changedKeys` fields from `config unset --json` as the
authoritative write result. An already-unset key performs no write and returns
`unset: false`, `changed: false`, and `changedKeys: []`. A real unset returns
`unset: true`, `changed: true`, and every affected key. Configuration schema v1
couples the library fields: unsetting `library.remote` atomically removes the
remote, optional branch, and transport while preserving `defaults.*`; unsetting
an SSH transport resets it to HTTPS and reports both the normalized remote URL
and transport. Before setting a branch or transport, configure the remote with
`skill-sync config set library.remote <repository-url>`.

Configuration precedence is command option, environment, user config, then built-in default. Supported settings include `library.remote`, `library.branch`, `library.transport`, `defaults.targets`, and `defaults.gitignore`. Relevant environment variables are `SKILL_SYNC_LIBRARY`, `SKILL_SYNC_BRANCH`, `SKILL_SYNC_TRANSPORT`, `SKILL_SYNC_TARGETS`, `SKILL_SYNC_GITIGNORE`, `SKILL_SYNC_CONFIG_HOME`, and `NO_COLOR`.

When explaining results, label the affected scope. Project Codex copies live under `.codex/skills/<skill-name>` and Claude copies under `.claude/skills/<skill-name>` with project intent in `skill-sync.json` and `skill-sync.lock.json`. Global copies use the user-level locations and separate global state described above.
