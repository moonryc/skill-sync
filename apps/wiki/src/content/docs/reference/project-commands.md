---
title: Project commands
description: Exact usage for installing, reconciling, updating, and uninstalling managed skill copies.
---

Project commands resolve the current repository unless the global `--project <path>` option is present.

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
