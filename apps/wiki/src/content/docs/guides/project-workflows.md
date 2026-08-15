---
title: Project workflows
description: Install, inspect, update, synchronize, and remove managed project copies.
---

Run project commands from the destination repository or provide the global `--project <path>` option.

## Use the interactive command center

Run `skill-sync` with no subcommand in an interactive terminal, or run the
explicit command below:

```sh
skill-sync tui
```

The command center groups the catalog, supports search and multi-selection,
shows managed reconciliation badges, and reports valid Codex/Claude skill
directories that exist on disk but are not represented by this project's state.
Project and global dashboards honor a valid effective `defaults.targets` set
and fall back to Codex only when no valid target set is available.
The inventory is read-only while browsing. An eligible entry can be adopted only
after choosing an explicit compatible qualified canonical ID and accepting a
review; the final exact-digest verification writes tracking state only and never
overwrites the target directory. Install and sync actions always show a review
and use the normal collision, backup, and local-edit safety rules. `tui` is
unavailable with redirected streams, `--json`, `--no-input`, or `--yes`; use the commands
in this guide for automation.

Run `skill-sync --global` or `skill-sync --global tui` to use the same visual
workflow against user-level state; its inventory then identifies global skills
that exist on disk but are not globally tracked.

On first run, `Create GitHub library (starts empty)` makes the authoring state
explicit. After setup, a populated library opens the catalog with
`Space` selection and `i` install-review guidance. An empty library remains on
the overview and points exactly to `skill-sync add <path> --dry-run`. A catalog
with no search or group matches reports that filtered state separately and does
not suggest adding a skill.

## Adopt an existing exact copy

Use `adopt` when a valid agent target directory already exists and you want to
track it without replacing it. Supply the exact qualified canonical ID and the
target containing the local copy:

```sh
skill-sync adopt frontend/review-ui --target codex --dry-run
skill-sync adopt frontend/review-ui --target codex
```

The directory must exactly match the selected canonical skill. A divergent,
invalid, symlinked, missing, or already-managed path is refused unchanged.
For user-level copies, add `--global`.

## Install selected skills

```sh
skill-sync install frontend/review-ui \
  backend/review-api \
  --target codex \
  --target claude \
  --gitignore \
  --dry-run
```

Run the complete `Next: skill-sync ... --expect-plan ...` command printed by the human preview to
apply it. That handoff uses the resolved exact qualified IDs, or preserves `--all`, sorts repeated
`--target` flags, includes the resolved `--gitignore` or `--no-gitignore` project policy, and keeps
project/global scope; global handoffs omit the inapplicable policy flag. If you supplied an explicit
project, replace its safe `--project <project-path>` placeholder with the labeled path from the
preview. Repeat `--target` for each agent or use configured defaults. `--all` selects every eligible
skill. `--gitignore` and `--no-gitignore` explicitly control the project's managed ignore block.

A direct `install` with neither `--expect-plan` nor explicit `--yes` is still preview-first.
Interactive human use prints the plan and asks before applying it. When confirmation is unavailable
because of `--no-input`, `--json`, CI, or redirected streams, it returns a cache-only preview and
makes no project or global writes. `--expect-plan` applies the reviewed plan; explicit `--yes` is
the intentional one-command automation opt-in.

`install` creates new managed copies; it never acts as an update. Existing IDs, path collisions, invalid content, or unsafe destination state stop before writes.

## Install for all projects

Use explicit global scope when the skill belongs in your user-level agent setup:

```sh
skill-sync --global install frontend/review-ui --target codex --dry-run
# Run the exact --expect-plan command printed by the preview.
```

Global copies use `~/.codex/skills/<name>` or `~/.claude/skills/<name>`, with
separate skill-sync state. They do not create project manifests or manage a
project `.gitignore`. Add `--global` to `status`, `diff`, `sync`, `update`, or
`uninstall` to stay in this scope.

## Check reconciliation state

```sh
skill-sync status
skill-sync diff frontend/review-ui
skill-sync sync --check
```

`status` classifies each tracked target. `diff` focuses on one skill without printing unrelated file bodies. `sync --check` fetches current canonical state and reports drift without applying it.

## Refresh all tracked skills

```sh
skill-sync sync --dry-run
skill-sync sync
```

Safe outdated and missing copies are updated. Local-only changes are preserved; concurrent local and canonical changes become conflicts. Use `--discard-local` only after reviewing the diff and deciding that replacement is intentional:

```sh
skill-sync sync --discard-local --dry-run
skill-sync sync --discard-local
```

The destructive option and confirmation are separate safeguards. A backup is created before modified content is replaced.

## Refresh selected skills

```sh
skill-sync update frontend/review-ui --dry-run
skill-sync update frontend/review-ui
```

Pass several IDs or `--all`. `update --all` is equivalent to `sync`. Like `sync`, update never publishes local edits back to the library.

## Work from an explicit cached revision

Network-independent reconciliation requires the full commit ID of an existing cached revision:

```sh
skill-sync update frontend/review-ui --offline <full-commit>
skill-sync sync --offline <full-commit>
```

Offline output is marked stale and is never described as current with the remote. A missing or abbreviated revision is rejected rather than silently choosing another cache entry.

## Uninstall managed copies

```sh
skill-sync uninstall frontend/review-ui --dry-run
skill-sync uninstall frontend/review-ui
```

Pass `--all` to select every managed skill. Modified local copies are preserved unless `--discard-local` and confirmation explicitly authorize removal. Uninstall touches only selected managed copies and related project metadata; unrelated files beneath `.codex` or `.claude` remain intact.

For conflict classifications and backup handling, continue to [conflicts and recovery](/operations/conflicts-and-recovery/).
