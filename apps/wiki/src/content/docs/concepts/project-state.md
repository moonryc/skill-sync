---
title: Project state and reconciliation
description: Learn how managed copies, manifests, lock data, and three-way digests fit together.
---

Project state separates what you intend to install from the exact content currently managed.

## Managed targets

For a skill whose qualified ID is `frontend/review-ui`, both agents receive the leaf directory name:

```text
.codex/skills/review-ui/
.claude/skills/review-ui/
```

Installing two selected skills with the same leaf name into one target would collide. `skill-sync` detects that condition before writing.

## Manifest and lockfile

Two repository-root files describe managed state:

- `skill-sync.json` records installation intent: selected qualified IDs, targets, and ignore-file preference.
- `skill-sync.lock.json` records the exact library revision, content digests, and target copies used for reconciliation.

Treat both as project metadata and commit them when the project itself should share the same managed-skill intent.

## Three-way comparison

For each managed copy, reconciliation compares:

1. the base digest recorded in the lockfile;
2. the current local digest at the target path;
3. the canonical digest at the fetched or explicitly cached revision.

That comparison distinguishes current, safely outdated, locally modified, conflicted, missing, orphaned, and colliding states. `status` summarizes all copies; `diff <id>` shows target-specific local and canonical changes for one skill.

## Writes are staged

An update stages and validates replacement content before touching the project. All target copies for one skill commit atomically. Independent skills may produce a deterministic partial result, reported with exit status `6`, when one skill succeeds and another safely stops.

Discarding local changes requires `--discard-local` plus confirmation. Before replacement, the CLI creates a recoverable backup in its application state directory. `--yes` can answer a confirmation, but it cannot substitute for the destructive option itself.

## Managed `.gitignore` entries

With `--gitignore`, the CLI maintains exact installed paths inside a marked block instead of ignoring broad agent directories. Uninstalling the final managed path removes the corresponding managed entries while preserving unrelated user content.

See [conflicts and recovery](/operations/conflicts-and-recovery/) for operational guidance.
