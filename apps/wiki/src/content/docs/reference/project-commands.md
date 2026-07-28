---
title: Project commands
description: Exact usage for installing, reconciling, updating, and uninstalling managed skill copies.
---

Project commands resolve the current repository unless the global `--project <path>` option is present. The same installation and reconciliation commands can select user-level state with `--global`; `--project` and `--global` cannot be combined.

## `tui`

Open the interactive, keyboard-driven command center.

```text
skill-sync tui
```

A bare `skill-sync` invocation starts the same interface when both standard
input and output are terminals. It supports grouped browsing, search,
multi-skill installation reviews, managed-skill reconciliation views, and an
inventory of valid but untracked skills in supported agent directories. Eligible
inventory entries can be adopted after the user chooses an exact qualified
canonical ID and confirms a review; this writes tracking state only after an
exact content match and never replaces the target directory. The interface never
changes files until the user confirms a reviewed operation.
It rejects `--json`, `--no-input`, and redirected streams; use the argument-driven
commands below for scripts and CI.

## `install`

Install selected canonical skills into this project.

```text
skill-sync install [ids...]
```

| Option              | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `--target <target>` | Install to `codex` or `claude`; repeat for multiple targets.      |
| `--all`             | Select every eligible skill.                                      |
| `--gitignore`       | Add exact managed target paths to the managed `.gitignore` block. |
| `--no-gitignore`    | Leave managed target paths out of `.gitignore`.                   |
| `--dry-run`         | Preview destinations, state files, ignore edits, and conflicts.   |

Provide IDs or `--all`. Targets may come from repeated options or configured defaults. `install` only creates new managed copies; it never updates an already managed ID.

### Global install

Use `--global` to write user-level target directories instead of the current
project. It never creates `skill-sync.json` in the current directory and does
not manage a project `.gitignore`:

```sh
skill-sync --global install frontend/review-ui --target codex
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

Add `--global` to adopt a user-level Codex or Claude copy into global state.

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
