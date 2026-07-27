---
title: Conflicts and recovery
description: Interpret reconciliation state, preserve local work, and recover interrupted operations.
---

`skill-sync` compares each managed copy against both its recorded base and canonical content. That three-way view lets it distinguish safe updates from ambiguous replacement.

## State classifications

| State            | Meaning                                                     | Typical next step                                            |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| Current          | Local, base, and canonical content agree.                   | No action.                                                   |
| Outdated         | Local still matches its base; canonical changed.            | Run `update` or `sync`.                                      |
| Locally modified | Canonical still matches the base; local changed.            | Review with `diff`, then publish or keep the edit.           |
| Conflicted       | Local and canonical both changed from the base.             | Choose a source deliberately; no automatic overwrite occurs. |
| Missing          | A tracked target copy is absent.                            | Recreate it through update when canonical state is safe.     |
| Orphaned         | The project tracks an ID that no longer exists canonically. | Keep, uninstall, or restore the canonical skill through Git. |
| Colliding        | Selected skills resolve to the same target leaf path.       | Change the selection or canonical IDs before installing.     |

## Inspect before resolving

```sh
skill-sync status
skill-sync diff frontend/review-ui
skill-sync sync --check
```

`status` gives the project-wide classification. `diff` focuses on one skill and separates target-local changes from canonical changes. `sync --check` fetches current canonical state but applies nothing.

## Preserve and publish local work

When local edits are intentional, publish the selected target instead of pulling over it:

```sh
skill-sync publish frontend/review-ui --from codex --dry-run
skill-sync publish frontend/review-ui --from codex
```

If both target copies contain different edits, select `--from codex` or `--from claude`. Publishing still stops if the canonical repository changes concurrently.

## Deliberately discard local work

Only use destructive replacement after reviewing the diff:

```sh
skill-sync update frontend/review-ui --discard-local --dry-run
skill-sync update frontend/review-ui --discard-local
```

`--discard-local` expresses overwrite intent; a separate confirmation authorizes the operation. `--yes` can answer that confirmation but cannot stand in for the destructive option. Before replacement, the CLI creates a backup beneath its application state directory.

## Interrupted operations

Project writes are staged and journaled, and active operations hold locks. If a process is interrupted, the journal, lock, staging content, or backup remains visible. The next command and `doctor` report remediation instead of silently replaying or deleting state.

```sh
skill-sync doctor
```

Verify that no `skill-sync` process is active before following any abandoned-lock remediation. Keep backups until the project metadata and target copies have been checked.

## Partial batches

All target copies for one skill commit atomically, but separate skills are independent. A batch can therefore update one skill and safely stop another. This is a deterministic partial result with exit status `6`; rerun `status`, resolve the remaining item, and repeat the selected operation.
