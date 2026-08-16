# skill-sync

`skill-sync` is a globally installed CLI for keeping reusable AI skills in one
GitHub repository and projecting selected skills into Codex and Claude project
folders or user-level global directories. The canonical library is grouped,
versioned by Git, validated before every write, and changed through explicit CLI
commands.

## Requirements and installation

- Node.js 22 or newer
- Git on `PATH`
- Git credentials or an SSH agent that can access the library repository
- Optional: the GitHub CLI (`gh`) for `init --create`

```sh
npm install --global @moonryc/skill-sync
skill-sync --help
```

Optionally enable completion in the current shell:

```sh
# Bash
source /dev/stdin <<< "$(skill-sync completion --shell bash)"

# Zsh (after compinit is initialized)
source <(skill-sync completion --shell zsh)

# Fish
skill-sync completion --shell fish | source
```

In PowerShell:

```powershell
skill-sync completion --shell powershell | Out-String | Invoke-Expression
```

See the [installation guide](apps/wiki/src/content/docs/getting-started/installation.md#enable-shell-completion)
for conservative persistent setup that saves a generated file without letting
skill-sync edit a shell profile.

The package uses both HTTPS and SSH Git remotes. Plain HTTP input is upgraded to
HTTPS, credentials must not be embedded in URLs, and authentication remains in
Git credential helpers, SSH, or `gh`. If `init` cannot reach the remote, its
repository error keeps a short, sanitized Git reason and tells you whether to
check HTTPS credentials or SSH keys; it does not write configuration or cache
state first. `init --dry-run` uses disposable temporary storage to validate the
exact remote and configuration state without populating the persistent cache.
Applying a reviewed connection rechecks the selected branch before any cache
write, then promotes that exact validated commit from temporary storage rather
than fetching a potentially different revision.
With `init --create`, availability and authentication are checked before the
repository is created. Once any `init` apply starts, skill-sync records the
provider-creation, initial-push, and saved-configuration phases as inspect-only
recovery evidence. If setup is interrupted, the repository or pushed commit may
already exist; skill-sync never automatically replays or deletes those external
changes.

If a reachable, nonempty repository is not already a skill-sync library,
`init` leaves both its contents and the saved library connection unchanged and
points to three valid routes: choose a compatible library, use an empty
repository, or preview `skill-sync init --create <owner/name> --dry-run`. Planning uses a
disposable checkout, so an incompatible remote does not populate the persistent
cache and is never reinitialized.

## Quick start

Connect an existing compatible repository:

```sh
skill-sync init git@github.com:you/ai-skills.git --dry-run
# Run the exact --expect-plan command printed by the preview.
```

Or create a private GitHub repository (the default visibility):

```sh
gh auth login
skill-sync init --create you/ai-skills --transport ssh --dry-run
# Run the exact --expect-plan command printed by the preview.
```

The explicit preview-first examples above are the recommended default. A direct
`skill-sync init ...` with none of `--dry-run`, `--expect-plan`, or `--yes`
still builds the same plan before it can apply anything. In an interactive
human terminal, the CLI prints that plan and asks whether to apply it. When a
confirmation prompt is unavailable—for example with redirected streams,
`--no-input`, or `--json`—it returns the preview without making setup changes.
Use the preview's exact `--expect-plan` command to apply the reviewed plan.
Explicit `--yes` is the intentional opt-in for automation that must plan and
apply in one command.

For a guided first run, launch `skill-sync` with no subcommand. Its setup review
shows the same validated application plan and rechecks it before any remote,
cache, or configuration change.

If the library already contains skills, browse it and install one into a project:

```sh
skill-sync list
cd /path/to/project
skill-sync status
skill-sync install frontend/review-ui --target codex --target claude --gitignore --dry-run
# Run the exact --expect-plan command printed by the preview.
```

Fresh human `list` and `info` results make that handoff executable: for an
uninstalled skill, `Next:` prints a complete `--dry-run` preview command. It
prefers Codex when compatible (otherwise Claude), includes `--gitignore` for a
project, and uses the policy-free global form for user-level installs, so the
printed command does not fail on another missing choice or write files.
Likewise, validating a canonical skill ID points to `info` for compatibility and
that same complete preview instead of printing an underspecified install.

On a fresh project, or after the final managed skill is removed, `status`
reports that no skills are managed and points to `init` when a library is not
connected, or back to `list` and its complete preview-ready install command when
one is. Later, pull safe canonical changes with `skill-sync sync`. Use `status`
and `diff` before deciding whether to discard local changes or publish them.
When a command was aimed at another checkout with `--project`, human follow-up
commands retain `--project <project-path>`; replace that placeholder with the
`Project` or `Scope` path printed above it. This prevents a copied next command
from silently operating on the current directory instead.

`skill-sync --global status` has the same novice-safe empty state. Online or
with `--offline`, it succeeds before library or cache resolution when neither
global state file exists and performs no state write. When unconfigured, it
names both `skill-sync init <repository-url> --dry-run` and
`skill-sync init --create <owner/name> --dry-run`, says to run the printed
`--expect-plan` command, then names `skill-sync list --global`; when
connected, it points directly to `skill-sync list --global`. If either global
state file already exists, normal state and library validation still applies.

Library authors can add a local directory that already contains a valid
`SKILL.md`; consumers do not need this step:

```sh
skill-sync add ./review-ui --group frontend
```

To make a skill available at user level instead, select the explicit global
scope. It writes no project metadata and never changes a project's `.gitignore`:

```sh
skill-sync --global install frontend/review-ui --target codex --dry-run
# Run the exact --expect-plan command printed by the preview.
# After applying, verify the managed copy:
skill-sync --global status
```

Human setup and mutation results are short operational summaries rather than
raw data objects. Install and uninstall previews show scope, revision,
freshness, destinations, `.gitignore` effects, planned writes, and backup
requirements before suggesting the next command. Install previews always show
every selected skill and destination because they are authorization plans. A
no-op preview points to status instead of asking for a meaningless apply;
completed install and uninstall summaries label completed writes, show at most
20 sorted skills, and end with scope-correct `status` guidance. Completed
uninstall output also distinguishes a created recovery backup from a previewed
backup requirement. Adoption explicitly confirms that existing target files
were not replaced, labels previewed versus completed tracking writes, and
preserves global scope in its verification command. `--json` preserves the
complete versioned machine-readable contract, including bare quick-start and
`version` invocations.

When a human dry-run is printed where prompts are unavailable, its destructive
apply handoff names `--yes` whenever the next command requires it. This covers
canonical or group removal, recovery actions, and uninstalls that must back up
local edits; interactive and non-destructive handoffs remain unchanged.

## Interactive workflow

In an interactive terminal, run `skill-sync` with no subcommand—or use the
explicit `skill-sync tui` command—to open a colorful keyboard-driven command
center. Browse groups, search skills, select Codex and Claude targets, review
an install, inspect managed-state badges, and see valid on-disk skills that are
not tracked by the selected project or global state.

Project and global dashboards initialize their install targets from the
effective `defaults.targets` setting. A valid configured set is honored in
either scope; the dashboard falls back to Codex only when no valid target
set is available.

Before a library is configured, the command center offers to connect an
existing repository, `Create GitHub library (starts empty)`, run diagnostics,
show the setup guide, or quit. Invalid connect URLs and create names show an inline
error with a valid example while preserving the entered text for correction;
credential-bearing URLs get specific safe guidance. Valid input opens a
separate review: connect shows the normalized credential-free URL plus its
cache/configuration effects and empty-remote follow-up, while create shows the private HTTPS `main` repository,
external creation, initial push, and may-remain-on-failure warning. Only `y`
starts setup; Esc returns to the editable form. Library setup is user-wide even
when the dashboard was opened with `--project` or `--global`, and those scope
selectors are never passed to `init`. Setup failures stay visible, and
successful setup reloads the normal dashboard. A populated library opens the
catalog with `Press Space to select a skill, then i to review installation.` An
empty library stays on the overview with
`It has no skills yet. Open Unmanaged inventory to add an on-disk skill, or run skill-sync add <path> --dry-run.`
In the catalog, a genuinely empty library instead says
`This library has no skills yet. Open Unmanaged inventory to add an on-disk skill, or run skill-sync add <path> --dry-run.`;
a search or group filter with no matches says
`No skills match the current search and group filter.` and does not suggest
adding a skill. Press `x` on a catalog skill to review canonical removal. The
review shows the exact ID and library revision, warns that installed copies
remain orphaned, and repeats the dry-run on `y`; a changed revision requires
another confirmation before deletion. When a bare
invocation is piped or otherwise noninteractive, it prints a short setup preview →
exact apply → `list` → `install` quick start and exits without reading configuration,
recovery state, project files, or the network.

The TUI changes nothing until a first-run setup review, reviewed install or
synchronization, or unmanaged-skill action is confirmed. Press `Enter` or `a`
on an eligible inventory entry to browse library groups with the arrow keys.
Every location offers `Save in …`, immediate child folders, and `Add folder`;
one portable folder name opens the new location so nested folders can be built
before review. Those folders remain virtual until confirmation adds the local
content as a canonical skill and tracks the unchanged local copy. Press `d` to adopt an already-canonical skill
after choosing its exact qualified ID. Adoption requires an exact content match,
records state only, and never replaces target files. Viewing an unmanaged skill
never changes, publishes, or deletes it. Use regular commands for pipes, CI, `--json`, `--no-input`, `--yes`,
and deterministic offline workflows.

Install review is generated by the real `install --dry-run` planner and shows
the revision and freshness, destinations, state writes, and actual `.gitignore`
delta. Press `g` to change the policy; target or policy changes refresh the
preview. Confirmation runs the preview again, and a changed fingerprint returns
to review instead of installing; a matching plan is applied with that exact
fingerprint. The inline preview points to the current confirmation prompt and
says no second command is needed; only a standalone `--dry-run` prints a
fingerprint-bound apply command. If that inline preview finds everything
already installed, it returns status guidance immediately instead of asking the
user to confirm an empty plan. Long catalog, managed, unmanaged, and adoption
lists scroll with the active row and show the visible range, so keyboard actions
never target an off-screen item.

Setup diagnostics are rendered from the same structured `doctor` report even
when a failed check gives `doctor` a nonzero exit status. The screen shows
pass, warning, fail, and skipped counts; orders failures before warnings and
skipped checks; keeps long issue lists within the terminal with an omitted-row
indicator; and prints the remediation as `Next:`. Press `r` to run the checks
again or Enter/Esc to return. Internal JSON is never printed into the TUI.

When a newer stable CLI release is available, the TUI shows a quiet footer
indicator with the installed and available versions. It never blocks input or
changes a command result. Run `skill-sync self-update` after leaving the TUI to
update the global npm installation; normal argument-driven commands do not
perform this registry lookup.

## Canonical library layout

```text
.skill-sync/
  library.json
skills/
  format-code/
    SKILL.md
  frontend/
    .skill-sync-group.json
    review-ui/
      SKILL.md
      references/
      scripts/
```

Directories below `skills/` are groups until a directory containing `SKILL.md`
is found. A skill is then a leaf and is identified by its complete path, such as
`frontend/review-ui`. Lowercase portable group and skill names are required.
Duplicate leaf names may exist in different groups, but an unqualified selector
works only when it is unambiguous.

Project copies are installed at `.codex/skills/<leaf-name>` and
`.claude/skills/<leaf-name>`. Global copies use `~/.codex/skills/<leaf-name>`
and `~/.claude/skills/<leaf-name>` on supported platforms. Projects record
intent in `skill-sync.json` and exact revisions and digests in
`skill-sync.lock.json`; global state is stored separately under skill-sync's
user state directory as `global/skill-sync.json` and
`global/skill-sync.lock.json`.

## Commands

Argument-driven commands broadly accept `--json` and `--no-color`; the terminal
UI accepts `--no-color` but not `--json`. Input controls are capability-based:
`--no-input` and `--yes` are accepted only by commands that may prompt, such as
`init`, `install`, `sync`, `update`, `publish`, `uninstall`, recovery actions,
`library remove`, and `group remove`. Read-only and non-prompting commands reject
those flags with `OPTION_UNSUPPORTED` before configuration, project, cache, or
network work. Project and global scope flags are likewise declared per command.
Global scope is supported by `tui`, `install`, `adopt`, `sync`, `update`,
`status`, `diff`, `uninstall`, `list`, `info`, `validate`, `doctor`, and
`recovery prune`; it is always explicit. JSON mode disables prompts and emits
exactly one versioned object. In automation, provide every required selector
and choice explicitly, and add `--no-input` only when the selected leaf help
advertises it.

Run `skill-sync --help` for a categorized workflow map. Leaf help such as
`skill-sync init --help` and `skill-sync install --help` includes valid choices,
runnable examples, supported inherited options, safety notes, and the wiki link.
The same typed command registry drives parsing and leaf help, so unsupported
scope or input-control flags, invalid choices, and conflicting selections fail
with a usage error before configuration, project, cache, or network work begins.
Two common first-run guesses receive direct guidance rather than an unrelated
fuzzy match: top-level `skill-sync setup` points to
`skill-sync init <repository-url> --dry-run`, and top-level `skill-sync create` points to
`skill-sync init --create <owner/name> --dry-run`. They remain usage errors and stop before
startup recovery or application state is inspected. Similar safe typos such as
`instal` still suggest the intended command without running it.
For example, the CLI rejects `--global` with `--project`, explicit IDs with
`--all`, `--gitignore` with `--no-gitignore`, and `config list --yes` instead of
guessing or silently ignoring an option.

### CLI lifecycle

| Command                      | Purpose                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `version`                    | Print the installed package's semantic version. `-V` and `--version` print the same value.                              |
| `self-update`                | Run `npm install --global @moonryc/skill-sync@latest` without a shell to update the global npm installation explicitly. |
| `completion --shell <shell>` | Print deterministic static completion for Bash, Zsh, Fish, or PowerShell without reading application state.             |

`completion` requires one of `bash`, `zsh`, `fish`, or `powershell`. Without
`--json`, stdout contains only the sourceable completion script. With `--json`,
the versioned result's data is `{ "shell": "...", "script": "..." }`. Script
generation does not read or write configuration, cache, project, global, or
profile state, contact the network, or edit shell startup files.

### Library connection and mutation

| Command                      | Purpose and important options                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [url]`                 | Connect a compatible HTTPS or SSH remote. `--dry-run` validates a write-free plan; `--expect-plan <fingerprint>` applies only that current plan. Apply promotes the reviewed exact commit instead of refetching it. |
| `init --create <owner/name>` | Create and initialize a GitHub repository. Options: `--visibility private\|public\|internal`, `--transport`, `--branch`, `--dry-run`, `--expect-plan`.                                                              |
| `add <path>`                 | Validate and add a new canonical skill. Options: `--group <path>`, `--dry-run`. Existing IDs are refused; use `publish` for updates.                                                                                |
| `publish [ids...]`           | Publish edits from tracked project copies to existing canonical skills. Options: `--all`, `--from codex\|claude`, `--dry-run`. Divergent targets require `--from`.                                                  |
| `library remove <id>`        | Delete one canonical skill after confirmation. Project copies remain installed and become orphaned. Option: `--dry-run`.                                                                                            |
| `group list`                 | List explicit library groups.                                                                                                                                                                                       |
| `group create <group>`       | Create a persistent group marker.                                                                                                                                                                                   |
| `group rename <from> <to>`   | Move a group subtree and report affected qualified IDs.                                                                                                                                                             |
| `group remove <group>`       | Remove an empty group. `--recursive` is required for a nonempty group and does not replace confirmation. Option: `--dry-run`.                                                                                       |

For `init`, omitting all three apply controls—`--dry-run`, `--expect-plan`, and
`--yes`—does not silently authorize setup. Interactive human use prints the
plan before asking for confirmation; noninteractive use returns that preview
without applying it. `--expect-plan` applies the exact reviewed fingerprint,
while explicit `--yes` opts into plan-and-apply behavior for one-command
automation. Prefer the preview-first examples above.

Library writes use a clean exact-revision checkout, validate the complete
result, create a normal commit, and push without force. If another writer
changes touched content, the command stops instead of overwriting it.

### Project installation and reconciliation

| Command              | Purpose and important options                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui`                | Open the interactive command center. The same interface starts for a bare interactive `skill-sync` invocation; its help omits and its parser rejects `--json`, `--no-input`, and `--yes`.                                                                                 |
| `install [ids...]`   | Install selected skills from one library revision. Options: `--all`, repeated `--target codex\|claude`, `--gitignore`/`--no-gitignore`, `--dry-run`, `--expect-plan <fingerprint>`. With `--global`, destinations and state are user-level and `.gitignore` is unchanged. |
| `adopt <id>`         | Track one exact existing unmanaged target copy. Requires `--target codex\|claude`; validates the local directory against the exact qualified canonical ID and writes state only. Option: `--dry-run`; supports `--global`.                                                |
| `sync`               | Pull all safely reconcilable tracked skills. Options: `--check`, `--dry-run`, `--discard-local`, `--offline <full-commit>`. Add `--global` for user-level copies.                                                                                                         |
| `update [ids...]`    | Pull selected tracked skills. Options: `--all`, `--dry-run`, `--discard-local`, `--offline <full-commit>`. `update --all` is equivalent to `sync`; add `--global` for user-level copies.                                                                                  |
| `uninstall [ids...]` | Remove only selected managed copies. Options: `--all`, `--discard-local`, `--dry-run`; add `--global` for user-level copies.                                                                                                                                              |

`install` never acts as an update, while `sync` and `update` never publish.
`self-update` updates the npm CLI package instead; it never reconciles skills.
The recommended install path first runs the complete command with `--dry-run`,
then copies the complete `Next: skill-sync ... --expect-plan install-v1-...`
command printed by the human preview. The handoff contains the resolved exact
qualified IDs (or preserves `--all`), deterministically sorted repeated
`--target` flags, and the project or global scope. For project scope it includes
the resolved `--gitignore` or `--no-gitignore` policy. An explicit project
selection remains the safe `--project <project-path>` placeholder; replace it
with the labeled project path from the preview instead of expecting skill-sync
to interpolate a filesystem path into shell syntax. The fingerprint binds the
selected revision, scope, destinations, existing content, resulting state,
`.gitignore` delta, and planned writes. If any of those inputs changed, the apply fails with
`INSTALL_PLAN_CHANGED` before staging, journaling, or changing managed content
or state; review the new preview instead. `--dry-run` and `--expect-plan` cannot
be combined.

A direct `install` with neither `--expect-plan` nor explicit `--yes` is also
preview-first. Interactive human use prints the complete plan and asks before
applying it. When confirmation is unavailable—because of `--no-input`,
`--json`, CI, or redirected streams—the command returns a cache-only preview
and makes no project or global writes. `--expect-plan` applies the exact
reviewed plan; explicit `--yes` is the intentional one-command automation
opt-in. A preview that finds every selected target already installed says
that no changes are planned and points to the matching project or global
`status` command instead of suggesting `--expect-plan`. Final human summaries
label completed writes, show at most 20 sorted skills with an omitted count,
and preserve `skill-sync --global status` for global verification. JSON remains
complete and unbounded.
Destructive replacement requires the explicit `--discard-local` option and a
separate confirmation. `--yes` can answer a confirmation but cannot substitute
for `--discard-local` or `--recursive`. Before discarding modified copies, the
CLI creates a recoverable backup in its application state directory.

`--dry-run` reports destinations, state, ignore-file changes, conflicts, and
backup requirements without changing the project or cache. `sync --check`
returns drift information without applying it. `--offline <revision>` is an
explicit exact cached commit; offline results are marked stale and are never
reported as current with the remote. Human `sync` and `update` output summarizes
the selected and per-outcome counts, write and backup paths, and at most 20
skills, then gives a scope-correct next action for applying, resolving a
conflict, retrying a failure, or verifying status. JSON retains every result.
An orphaned skill cannot be repaired by `sync`: `status`, `diff`, and a skipped
reconciliation instead point to `uninstall <id> --dry-run` to review removal,
or tell the user to restore the canonical skill to the library.

### Inspection and troubleshooting

| Command                   | Purpose and important options                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                    | List grouped catalog entries. Repeatable filters: `--group`, `--query`, `--agent`, `--state`.                                                                                                                        |
| `info <id>` / `show <id>` | Show validated metadata, revision, digest, and file inventory without printing file bodies. `show` is the declarative read-only alias for `info`.                                                                    |
| `status`                  | Classify tracked copies as current, outdated, locally modified, conflicted, missing, orphaned, or colliding; a fresh project or global scope returns an actionable empty state. Option: `--offline`; add `--global`. |
| `diff <id>`               | Show target-specific local/canonical digest changes for one tracked skill. Add `--global` for user-level state.                                                                                                      |
| `validate [id-or-path]`   | Validate the configured library, a canonical or installed skill, or an explicit local skill directory. Nothing is executed.                                                                                          |
| `doctor`                  | Run all applicable runtime, Git, GitHub CLI, authentication, config, cache, schema, state, and destination checks. Its human report groups clear statuses and next actions. Options: `--offline`, `--global`.        |

Validation guidance preserves what was checked. A failed explicit
`validate <id-or-path>` says to rerun `validate <same-id-or-path>` after the
fix, while catalog, canonical-skill, and installed-copy handoffs retain global
or explicit project scope. JSON results keep the same structured contract.

`doctor --offline` performs no network operation. Its human report identifies
scope and offline mode, gives full `pass`, `warning`, `fail`, and `skipped`
counts, then shows at most 20 checks in failure-first order with an omitted
count. It lists numbered remedies for visible warnings and failures and always
ends with `Next:`—rerun after the first remedy, complete skipped remote checks,
or browse the scope when healthy. `--no-color` keeps the same information
without ANSI styling; `--json` retains every structured check. It never repairs
or creates state.

Human `list` and `info` results begin with the selected scope plus library
identity, revision, and freshness. `list` reports the total match count, shows
at most 20 entries, names how many were omitted, and ends with a runnable next
step. `info` reports the file count, shows at most 25 inventory entries, names
any omitted files, and suggests the safe next command. A stale `list` or `info`
result asks the user to rerun when remote access is available and does not
suggest a mutation; neither command accepts `--offline`. Project and global
`status` similarly summarize managed-state counts and show at most 20 skills;
`diff` summarizes target and difference counts and shows at most 25 differences
per target. Both identify stale data and end with a scope-correct action; only
`status` accepts `--offline`, while stale `diff` guidance asks for a remote
retry. If offline status has no verified cache yet, it tells the user to rerun
the same status command without `--offline` once remote access is available;
that online run populates the verified cache. Before global state exists,
online and offline `status --global` return `managed: false` without resolving
the library or cache; existing state still requires normal validation.

`show <id>` is a declarative alias for that same read-only `info` workflow;
structured output continues to identify the command as `info`. When a
syntactically valid selector has no exact match, discovery may report at most
three deterministic closest exact IDs. Each candidate must be within edit
distance 2 and meet the 60% similarity floor, and no candidate is selected
automatically. Human `info` errors turn one candidate into a scope-correct exact
`info` retry, list each exact `info` choice for an ambiguity, or fall back to the
scope-correct `list` command when no conservative candidate exists. JSON keeps
the candidates in the structured selector error. Mutating commands remain
fail-closed: candidates are advisory only, no fuzzy selection is applied, and
the CLI never reconstructs a mutation command from one.

### Interrupted-operation recovery

| Command                   | Purpose and important options                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recovery list`           | List unresolved recovery records without changing them. Options: `--scope <scope>`, `--include-terminal`.                                                                                                                    |
| `recovery inspect <id>`   | Inspect one stable record ID from `recovery list` without changing it.                                                                                                                                                       |
| `recovery unlock <id>`    | Remove one abandoned same-host advisory lock after dead-process proof and 60 seconds from the later of metadata creation or its latest persisted heartbeat. Preview with `--dry-run`; confirm interactively or pass `--yes`. |
| `recovery resume <id>`    | Finish an interrupted operation from verified evidence. Use `--dry-run` before confirmation.                                                                                                                                 |
| `recovery restore <id>`   | Restore the recorded pre-operation state from verified evidence. Use `--dry-run` before confirmation.                                                                                                                        |
| `recovery prune <ids...>` | Remove only selected terminal records or verified backups. Use `--dry-run`; unresolved or inspect-only records are refused. Add `--global` only for global recovery state.                                                   |

Always begin with `recovery list`; `inspect`, `unlock`, `resume`, `restore`, and
`prune` require a stable ID it displays. Never delete journals, locks, staging
paths, or backups by hand.

`recovery list`, `recovery inspect`, and `recovery unlock` search the application
recovery store and do not accept `--project` or `--global`. Only `recovery list`
accepts `--scope <scope>` as a filter; `unlock` accepts one stable lock ID and no
scope flag. Human inspection prints affected destinations and, for a
project-owned action, the applicable preview command with
`--project <affected-project>` before `recovery resume`, `restore`, or `prune`.
Those three scope-aware action commands canonicalize the selected project or
global root, including resolving symlink aliases, before matching evidence,
planning, or taking the scope lock. Keep the project selector printed by
inspection when the affected project is not the currently discovered Git root.

For a valid advisory-lock record, preview the singular cleanup action before
confirming it:

```sh
skill-sync recovery unlock <id> --dry-run
skill-sync recovery unlock <id>
# For an explicitly reviewed noninteractive apply:
skill-sync recovery unlock <id> --yes
```

Owned advisory locks persist a heartbeat by refreshing their lock-file
modification time every 15 seconds. Unlock succeeds only when the lock names
this host, the operating system can prove that its recorded PID is no longer
active, and the fixed 60-second crash grace has elapsed from the later of the
metadata creation time and the last persisted heartbeat. This grace gives
orphaned child processes time to exit.
Apply serializes on a crash-visible recovery action lock derived from the stable
record ID, then revalidates the exact reviewed path, full owner metadata,
60-second grace, and plan fingerprint while holding it before removing only
that lock file. An active owner, a foreign host, a younger lock, malformed
metadata, changed evidence, or any process state that cannot be disproved is
refused and preserved. Do not work around a refusal by deleting the lock
manually.

Successful deletion is followed by a durability sync of the lock's parent
directory. If that sync is ambiguous, skill-sync does not report clean
completion and deliberately leaves the recovery action lock visible for
`recovery list` and inspection. JSON inspection and unlock previews include the
safe owner fields but never expose the internal `ownerToken` used for ownership
and fingerprint checks.

Initialization records use a different, manual path. Provider repository
creation, the initial push, and saved configuration are recorded as inspect-only
evidence, so `recovery resume`, `recovery restore`, and `recovery prune` cannot
act on those records. External repository changes are never replayed or deleted
automatically. Inspect the repository and branch with the provider, run the
exact fresh `skill-sync init ... --dry-run` command printed by `recovery
inspect`, and review its current plan. If it is correct, run the exact
`--expect-plan` command printed by that preview. A successful setup for the same
remote clears its older matching initialization evidence.

Human recovery output is bounded and decision-oriented. `list` reports the
record count, shows at most 20 sorted records, states that it is read-only, and
uses the first actual ID in its `Next:` command. `inspect` distinguishes
recoverable, inspect-only, and cleanup-only evidence and explains “finish the
interrupted operation” versus “return to the prior state.” Unlock output names
the exact lock, recorded operation, PID, host, scope, dead-process-plus-grace
proof, and plan fingerprint. Resume, restore, and prune previews and results label scope,
state, counts, and fingerprints, show at most 20 destinations or owned paths
with omitted counts, translate internal recovery actions into plain language,
and finish with the applicable apply or verification command. JSON results
remain complete and structurally unchanged.

### Configuration

```sh
skill-sync config path
skill-sync config list
skill-sync config get library.remote
skill-sync config set defaults.targets codex,claude
skill-sync config unset defaults.gitignore
```

Supported keys are `library.remote`, `library.branch`, `library.transport`,
`defaults.targets`, and `defaults.gitignore`. Precedence is command option,
environment, user config, then built-in default. Useful environment variables:

- `SKILL_SYNC_LIBRARY`
- `SKILL_SYNC_BRANCH`
- `SKILL_SYNC_TRANSPORT`
- `SKILL_SYNC_TARGETS` (comma-separated)
- `SKILL_SYNC_GITIGNORE` (`manage` or `leave`)
- `SKILL_SYNC_CONFIG_HOME` (isolated config/cache/state root)
- `NO_COLOR`

Configuration contains no credentials and is written atomically. Platform
defaults follow macOS Application Support/Caches, Windows AppData, and the XDG
directories on Linux. Human `config path` output labels the active path and a
next step. `config list` reports how many supported keys are persisted, then
labels every key's configured value, effective value, and effective source.
`config get`, `set`, and `unset` repeat those labels for the selected key so a
fallback from the environment or built-in defaults is visible immediately.
Empty configured arrays display as `<none>`, while an absent override displays
as `<unset>`; `config get` suggests `unset` only when an override exists.
`config unset` reports whether anything changed and names every changed key. In
configuration schema v1, unsetting `library.remote` atomically removes the
coupled remote, optional branch, and transport while preserving independent
defaults. Unsetting an SSH transport resets it to HTTPS and reports both the
normalized remote URL and transport as changed. An already-unset key performs
no write and reports no change; JSON returns `unset: false`, `changed: false`,
and `changedKeys: []`. Set `library.remote` before branch or transport; validation
prints the exact command `skill-sync config set library.remote <repository-url>`.

## Conflict and recovery model

Each managed copy is compared three ways: its recorded base digest, current
local digest, and fetched canonical digest. Safe outdated and missing copies can
be pulled. Local-only edits are preserved, while simultaneous local and
canonical changes are reported as conflicts. A batch commits all target copies
of one skill atomically; independent skills may produce a deterministic partial
result.

If a process is interrupted, operation journals, locks, and backups remain
visible. The next CLI startup and `doctor` report safe remediation rather than
silently deleting or replaying them. Always identify and inspect the record
first:

```sh
skill-sync recovery list
skill-sync recovery inspect <id>
```

The structured `doctor` report includes a read-only `Recovery state` check in
human, JSON, and TUI diagnostics. A clean store passes; valid locks, incomplete
journals, or backups produce a warning with counts; malformed or unsafe evidence
fails locally. Every non-passing result points to the two commands above and
does not create, remove, or repair recovery files.

For an ordinary record that inspection labels recoverable, use the exact
preview-first direction it offers:

```sh
skill-sync recovery resume <id> --dry-run
# or: skill-sync recovery restore <id> --dry-run
```

For a valid advisory-lock record, use the separate singular, scope-less path:

```sh
skill-sync recovery unlock <id> --dry-run
skill-sync recovery unlock <id>
```

The apply requires interactive confirmation or explicit `--yes` and proves the
recorded PID is absent on this same host. Owned advisory locks refresh their
persisted lock-file mtime heartbeat every 15 seconds; the fixed 60-second crash
grace runs from the later of metadata creation and that last persisted
heartbeat. Applies serialize per stable record on a crash-visible recovery
action lock and revalidate the exact reviewed path, owner, grace, and
fingerprint while holding it before removing only that lock. Active,
foreign-host, too-young, malformed, changed, or unverifiable locks are refused
and preserved; never delete one by hand to bypass that refusal. If syncing the
lock's parent directory leaves deletion durability ambiguous, the action lock
remains as inspectable recovery evidence. JSON inspection and preview never
expose the internal `ownerToken`.

Resume completes the recorded operation; restore returns to the recorded
pre-operation state. Both refuse ambiguous or legacy inspect-only evidence.
They also do not act on inspect-only initialization records. For those records,
inspect the provider state, run the exact fresh `init --dry-run` command printed
by inspection, then apply the exact `--expect-plan` command printed by that
preview. Successful setup for the same remote clears older matching evidence;
skill-sync never automatically replays or deletes external repository changes.
Run list, inspect, and unlock without a root selector; unlock also rejects
`--scope`. When inspection prints a project-specific resume, restore, or prune
command, keep its `--project` option on that action.
Keep backups until the associated project state and copies are verified, and
use `recovery prune <id> --dry-run` only for terminal records or verified
backups. Git history is the recovery mechanism for canonical library deletions.

## Security boundaries

- Repository content is treated as inert data. The CLI does not run fetched
  scripts, hooks, filters, package lifecycle commands, or submodules.
- Skill trees reject symlinks, special files, nested Git repositories, path
  traversal, nested skill roots, malformed front matter, and case-fold
  collisions.
- Git commands use argument arrays, isolated hooks and filters, Windows
  long-path support, no force push, and external authentication. Diagnostics
  redact common credentials and tokens.
- Project writes are contained beneath the resolved project root and are staged,
  journaled, digest-checked, and atomically replaced where supported.

The “library is controlled through skill-sync” rule is a workflow policy, not a
property Git can enforce by itself. Direct pushes, web edits, or another Git
client can still change the repository. For stronger enforcement, use a private
repository, restricted credentials, branch protection, required checks, and a
ruleset that limits who may push.

## Exit statuses

| Status | Meaning                                                           |
| -----: | ----------------------------------------------------------------- |
|      0 | Complete success (warnings and skipped doctor checks are allowed) |
|      1 | Unexpected internal failure                                       |
|      2 | Invalid invocation or missing automation input                    |
|      3 | Configuration, schema, or local content validation failure        |
|      4 | Repository, authentication, or network access failure             |
|      5 | Conflict or unsafe overwrite refused                              |
|      6 | Explicit non-atomic batch completed only partially                |
|    130 | User cancellation or interrupt                                    |

## Development and release checks

```sh
npm ci
npm run check
npm run release:check
```

This repository is an Nx workspace. The publishable `skill-sync` package is the
`cli` library under `libs/cli`; builds stage its npm package at
`dist/libs/cli`. Existing npm scripts remain the stable entry points and route
project work through Nx. Individual targets can also be run directly:

```sh
npx nx show project cli
npx nx build cli
npx nx test cli
```

The CLI wiki is the Astro and React application at `apps/wiki`. Run it locally
or validate its static output through Nx-backed root scripts:

```sh
npm run wiki:dev
npm run wiki:build
npm run wiki:preview
```

The production wiki is written to `dist/apps/wiki`, separately from the staged
CLI package. When the public command surface changes, update this README, the
detailed wiki reference under `apps/wiki/src/content/docs/reference`, and the
searchable catalog at `apps/wiki/src/data/commands.ts` together.

`npm run check` runs formatting, linting, type checking, the production wiki
build, all CLI tests, and a packed CLI smoke test. `npm run release:check`
validates the staged package, and
`npm run publish:dry-run` performs a dry-run publish from `dist/libs/cli`. CI
covers Node.js 22 and 24 on Linux, macOS, and Windows and uploads the inspected
npm tarball. The unscoped `skill-sync` package name was unregistered when
checked on 2026-07-19; verify it again immediately before the first publish.
