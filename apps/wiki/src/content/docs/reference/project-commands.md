---
title: Project commands
description: Exact usage for installing, reconciling, updating, and uninstalling managed skill copies.
---

Project commands resolve the current repository unless the global `--project <path>` option is present. The same installation and reconciliation commands can select user-level state with `--global`; `--project` and `--global` cannot be combined.

Run `skill-sync <command> --help` for command-specific options, valid choices, examples, safety
notes, and the wiki link. Leaf help and parsing use the same typed registry. Unsupported scopes,
invalid choices, and conflicts such as `--global` with `--project`, IDs with `--all`, or
`--gitignore` with `--no-gitignore` fail before configuration, cache, project, or network work.

## `tui`

Open the interactive, keyboard-driven command center.

```text
skill-sync tui
```

A bare `skill-sync` invocation starts the same interface when both standard
input and output are terminals. It supports grouped browsing, search,
multi-skill installation reviews, managed-skill reconciliation views, and an
inventory of valid but untracked skills in supported agent directories. Press
`Enter` or `a` on an eligible entry to browse library groups with the arrow keys.
Each location offers `Save in …`, immediate child folders, and `Add folder`.
Entering one portable folder name opens the new location, allowing repeated
nested-folder creation before the user previews the canonical ID and digest.
The new folder path is created only when the reviewed add is confirmed; the TUI
then tracks the unchanged local copy. Press `d` to adopt an already-canonical skill after choosing
an exact qualified ID; this writes tracking state only after an exact content
match and never replaces the target directory. The interface never
changes files until the user confirms a reviewed operation.
Project and global dashboards initialize selected install targets from the
effective `defaults.targets` setting. A valid configured set is honored in
either scope, with Codex used as the fallback only when no valid target set
is available.
The explicit `tui` command's help omits and its parser rejects `--json`,
`--no-input`, and `--yes`; redirected streams are also rejected. Use the
argument-driven commands below for scripts and CI.

If a human command was aimed at another checkout with `--project`, its follow-up commands retain
`--project <project-path>`. Replace that placeholder with the `Project` or `Scope` path printed in
the result. Paths are not interpolated into shell commands, so unusual filenames cannot turn
guidance into executable shell syntax.

After the interface opens, it performs a bounded best-effort check for a newer
stable CLI release. When one exists, a passive footer indicator shows the
installed and available versions plus the `skill-sync self-update` command. The
indicator never changes focus, blocks input, or replaces an action result.

When no library is configured, the first screen offers Connect existing
library, `Create GitHub library (starts empty)`, Run diagnostics, Show setup guide, and Quit.
Those actions use the same `init` and `doctor` workflows as argument-driven
commands, keep failures on screen, and reload the dashboard after successful
setup. The connect and create forms validate before invoking those workflows;
malformed input stays in the field beside an inline valid example, and
credential-bearing URLs receive specific safe guidance. Editing clears the
validation message. Valid input opens a separate review and only `y` begins the
operation. Connect review shows the normalized credential-free URL, local
cache/configuration effects, and the separate empty-remote decision. Create review shows the private HTTPS `main`
repository, external creation and initial push, and warns that a repository may
remain after a later failure. Esc returns to the editable form. Setup configures
the same user-wide default library from project and global dashboards, so the
dashboard's `--project` or `--global` selector is not passed to `init`. The guide
screen is read-only and prints the wiki URL.

After setup, a populated library opens the catalog and says
`Press Space to select a skill, then i to review installation.` An empty library
stays on the overview and says
`It has no skills yet. Open Unmanaged inventory to add an on-disk skill, or run skill-sync add <path> --dry-run.`
The catalog also distinguishes an empty library from an empty filter result. A
truly empty library says
`This library has no skills yet. Open Unmanaged inventory to add an on-disk skill, or run skill-sync add <path> --dry-run.`;
a search or group filter with no matches says
`No skills match the current search and group filter.` and does not suggest the
add workflow.

Install review comes from the existing `install --dry-run` planner. It shows the
selected revision and freshness, every destination, state writes, and the actual
`.gitignore` delta. Press `g` to change that policy; target or policy changes
refresh the preview. Confirmation repeats the dry-run and compares the complete
plan fingerprint. A changed plan is displayed and requires another confirmation;
a matching plan is applied with that exact fingerprint. This inline preview
points to the current confirmation prompt and says no second command is needed;
a standalone `install --dry-run` still prints the exact fingerprint-bound apply
command. An inline no-op returns its scope-correct status guidance immediately
and never asks the user to confirm an empty plan.
Catalog, managed, unmanaged, and adoption-candidate lists keep the active row
visible and show the displayed range when more rows exist.

A bare invocation with redirected input or output does not attempt to launch
the interface. It prints a concise quick start with a write-free setup preview, the exact-apply
handoff, `list`, and explicit-target `install` examples, then exits successfully without reading
configuration, recovery evidence, project files, or the network.

## `install`

Install selected canonical skills into this project.

```text
skill-sync install [ids...]
```

| Option                        | Meaning                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `--target <target>`           | Install to `codex` or `claude`; repeat for multiple targets.                   |
| `--all`                       | Select every eligible skill.                                                   |
| `--gitignore`                 | Add exact managed target paths to the managed `.gitignore` block.              |
| `--no-gitignore`              | Leave managed target paths out of `.gitignore`.                                |
| `--dry-run`                   | Preview destinations, state files, ignore edits, and conflicts without writes. |
| `--expect-plan <fingerprint>` | Apply only when the exact reviewed dry-run plan is still current.              |

Provide IDs or `--all`. Targets may come from repeated options or configured defaults. In
noninteractive or JSON mode, a missing target reports `MISSING_TARGET_SELECTION` and shows
`--target codex`, `--target claude`, and the `defaults.targets` alternative. `install` only creates
new managed copies; it never updates an already managed ID. Human previews show the selected
revision and freshness, exact destinations, planned state writes, and whether `.gitignore` would
change. Refresh before applying a preview marked as stale.

Install is preview-first unless the caller explicitly selects an apply path:

- `--dry-run` creates a cache-only preview and never applies it.
- `--expect-plan install-v1-...` refreshes and applies only when that reviewed plan is still exact.
- A direct install with neither `--expect-plan` nor explicit `--yes` prints the complete plan before
  asking in an interactive human terminal. If confirmation is unavailable because of `--no-input`,
  `--json`, CI, or redirected streams, it returns a cache-only preview and makes no project or
  global writes.
- Explicit `--yes` opts into planning and applying in one command when automation intentionally
  needs that behavior.

For the recommended exact reviewed apply, copy the complete
`Next: skill-sync ... --expect-plan install-v1-...` command from the standalone human preview. It
contains the resolved exact qualified IDs, or preserves `--all`, sorts repeated `--target` flags,
includes the resolved `--gitignore` or `--no-gitignore` policy for project scope, and retains global
or project scope. An explicitly selected project is represented by the safe
`--project <project-path>` placeholder; substitute the labeled project path from the preview because
skill-sync never interpolates filesystem paths into executable shell guidance. The fingerprint
covers the selected library revision, scope, destinations, original digests, resulting manifest and
lock, `.gitignore` delta, and planned writes. If any input changed, apply reports
`INSTALL_PLAN_CHANGED` before staging, journaling, or changing managed content or state; run a fresh
preview. `--dry-run` and `--expect-plan` conflict and cannot be combined.

Dry-run output keeps every selected skill and destination visible because it is the authorization
plan. If every target is already installed, the preview says that no changes are planned and points
to the matching project or global `status` command instead of suggesting a no-op apply. A completed
human result labels writes as completed, shows at most 20 deterministically sorted skills with an
omitted count, and ends with scope-correct verification (`skill-sync --global status` for global
installs). JSON results remain complete and unbounded.

### Global install

Use `--global` to write user-level target directories instead of the current
project. It never creates `skill-sync.json` in the current directory and does
not manage a project `.gitignore`:

```sh
skill-sync --global install frontend/review-ui --target codex --dry-run
# Run the exact --expect-plan command printed by the preview.
# After applying, verify the managed copy:
skill-sync --global status
```

Global Codex and Claude destinations are `~/.codex/skills/<name>` and
`~/.claude/skills/<name>`. Global state is kept in skill-sync's user state
directory under `global/`.

## `adopt`

Record one existing unmanaged target copy as a normal managed skill without
copying, replacing, or deleting it.

```text
skill-sync adopt <id> --target <target> [options]
```

| Option              | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `--target <target>` | Required existing target: `codex` or `claude`.                           |
| `--dry-run`         | Validate the exact local/canonical match without writing tracking state. |

`<id>` must be the exact qualified canonical ID; leaf names are never inferred.
The derived supported target path must be a valid non-symlink skill directory
whose complete digest exactly matches that canonical skill. Otherwise `adopt`
leaves the local directory, manifests, locks, and `.gitignore` unchanged.
Human output names the existing target and explicitly confirms that adoption
does not replace its files. It labels tracking writes as planned in a dry run or
completed after apply, then ends with the scope-correct verification command.

Add `--global` to adopt a user-level Codex or Claude copy into global state. A
successful global adoption points to `skill-sync --global status`, never the
current project's status.

## `sync`

Refresh every tracked skill that can be reconciled safely.

```text
skill-sync sync [options]
```

| Option                 | Meaning                                                   |
| ---------------------- | --------------------------------------------------------- |
| `--check`              | Fetch and report drift without writing.                   |
| `--dry-run`            | Preview the complete reconciliation plan without writing. |
| `--discard-local`      | Explicitly allow replacement of local edits.              |
| `--offline <revision>` | Use one exact full commit already present in the cache.   |

`--discard-local` does not itself answer the confirmation, and `--yes` does not substitute for it. Backups are created before modified content is replaced. Offline results are marked stale.

Add `--global` to reconcile user-level copies with the same digest, local-edit,
backup, lock, journal, and confirmation safeguards.

Human output gives a result summary, per-outcome counts, unique write and backup
path counts, and at most 20 deterministically ordered skills. It preserves a
visible error for each displayed failure and ends with the exact project or
global command to apply, inspect, retry, or verify. JSON keeps the complete
unbounded result set.

## `update`

Refresh selected tracked skills.

```text
skill-sync update [ids...]
```

| Option                 | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `--all`                | Refresh every tracked skill; equivalent to `sync`.      |
| `--dry-run`            | Preview selected reconciliations without writing.       |
| `--discard-local`      | Explicitly allow replacement of local edits.            |
| `--offline <revision>` | Use one exact full commit already present in the cache. |

Provide IDs or `--all`. Update pulls canonical content into the project; it never publishes local edits.
Its human summary uses the same bounded outcome and next-action contract as
`sync`; selections of up to five IDs are repeated in an exact apply or retry
command.

## `uninstall`

Remove selected managed project copies.

```text
skill-sync uninstall [ids...]
```

| Option            | Meaning                                                |
| ----------------- | ------------------------------------------------------ |
| `--all`           | Select every managed skill.                            |
| `--discard-local` | Explicitly allow removal of locally modified copies.   |
| `--dry-run`       | Preview copy, state, and managed `.gitignore` changes. |

Provide IDs or `--all`. Modified copies stop by default. Uninstall removes only selected managed paths and related metadata, leaving unrelated agent files untouched.

With `--global`, uninstall removes only selected globally managed copies and the
matching global metadata. Existing unmanaged paths, collisions, symlinks, and
local edits are refused before mutation; `--discard-local` still requires a
separate confirmation and creates a recoverable backup.

Dry-run output keeps every selected skill and destination visible. Completed human output labels
writes as completed, says when a required backup was created, and shows at most 20 sorted skills
with an omitted count. Retry and verification guidance preserves the selected scope, including
`skill-sync --global status` after a global uninstall. When prompts are unavailable, a preview that
requires a backup tells the user to add `--yes` to its apply command. JSON remains complete and
unbounded.
