---
title: Project workflows
description: Install, inspect, update, synchronize, and remove managed project copies.
---

Run project commands from the destination repository or provide the global `--project <path>` option.

## Install selected skills

```sh
skill-sync install frontend/review-ui \
  backend/review-api \
  --target codex \
  --target claude \
  --gitignore \
  --dry-run
```

Remove `--dry-run` after reviewing the planned destinations. Repeat `--target` for each agent or use configured defaults. `--all` selects every eligible skill. `--gitignore` and `--no-gitignore` explicitly control the project's managed ignore block.

`install` creates new managed copies; it never acts as an update. Existing IDs, path collisions, invalid content, or unsafe destination state stop before writes.

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
