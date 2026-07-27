---
title: Automation and exit statuses
description: Run skill-sync deterministically in scripts and CI.
---

## Machine-readable mode

Use `--json` and `--no-input` for deterministic automation:

```sh
skill-sync --json --no-input status
skill-sync --json --no-input sync --check
```

JSON mode writes exactly one versioned object and disables prompts. Provide every required selector and choice explicitly, including IDs or `--all`, source targets, destructive intent, and recursion intent.

Use `--no-color` for human-readable logs that must not contain ANSI sequences. Use `--project <path>` to remove current-directory ambiguity.

## Preview mutations

Commands that can write expose `--dry-run`:

```sh
skill-sync --json --no-input install frontend/review-ui \
  --target codex \
  --gitignore \
  --dry-run
```

Dry-run output includes planned destinations, state and ignore-file changes, conflicts, and backup requirements without changing the project, cache-backed canonical repository, or working tree.

## Exit statuses

| Status | Meaning                                                           |
| -----: | ----------------------------------------------------------------- |
|    `0` | Complete success; warnings and skipped doctor checks are allowed. |
|    `1` | Unexpected internal failure.                                      |
|    `2` | Invalid invocation or missing automation input.                   |
|    `3` | Configuration, schema, or local content validation failure.       |
|    `4` | Repository, authentication, or network failure.                   |
|    `5` | Conflict or unsafe overwrite refused.                             |
|    `6` | Explicit non-atomic batch completed only partially.               |
|  `130` | User cancellation or interrupt.                                   |

Branch on the status as well as the JSON payload. In particular, `5` is a safe refusal rather than data loss, and `6` means some independent skills completed and project state must be inspected before retrying.

## Offline automation

Read-only diagnostics can skip network access:

```sh
skill-sync --json --no-input doctor --offline
skill-sync --json --no-input status --offline
```

Reconciliation can use one explicit full commit already in the cache:

```sh
skill-sync --json --no-input update frontend/review-ui --offline <full-commit>
```

Offline results are marked stale and never represented as current with the remote.
