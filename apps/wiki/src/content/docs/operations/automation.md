---
title: Automation and exit statuses
description: Run skill-sync deterministically in scripts and CI.
---

## Machine-readable mode

Use `--json` for deterministic machine-readable automation. Add `--no-input`
only when the selected command can prompt and its leaf help advertises the
option:

```sh
skill-sync --json status
skill-sync --json --no-input sync --check
```

JSON mode writes exactly one versioned object and disables prompts on
prompt-capable commands. Provide every required selector and choice explicitly,
including IDs or `--all`, source targets, destructive intent, and recursion
intent. Read-only and otherwise non-prompting commands reject explicit
`--no-input` and `--yes` with `OPTION_UNSUPPORTED` before command I/O instead of
silently ignoring them.

## Completion output

Shell completion is a special read-only automation surface. This form writes
only the deterministic sourceable script to stdout:

```sh
skill-sync completion --shell bash
```

Use JSON when a program needs to store or inspect the script rather than source
stdout directly:

```sh
skill-sync --json completion --shell powershell
```

The versioned envelope's data is `{ "shell": "powershell", "script": "..." }`.
The required shell choice is `bash`, `zsh`, `fish`, or `powershell`.
Generation uses static command metadata only: it does not read or write
configuration, cache, project, global, or profile state; inspect recovery
evidence; contact the network; or edit shell startup files. Do not add
`--no-input`, `--yes`, `--project`, or `--global`.

`skill-sync tui` (and a bare interactive `skill-sync` invocation) intentionally
does not run with `--json`, `--no-input`, `--yes`, or redirected terminal
streams. Those flags are omitted from TUI help. Use the commands in this guide
rather than attempting to automate the visual interface.

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

Initialization is safe when a script omits an apply control: direct `skill-sync init ...` without
`--dry-run`, `--expect-plan`, or explicit `--yes` returns its plan instead of applying when a prompt
is unavailable. Prefer an explicit `init --dry-run`, review the result, and apply its exact
`--expect-plan` fingerprint. Use `--yes` only as an intentional one-command automation opt-in to
plan and apply immediately.

Install follows the same authorization model. A noninteractive `install` without `--expect-plan`
or explicit `--yes` uses only the verified cache, returns the install preview, and makes no project
or global writes. A human `install --dry-run` preview prints a complete copyable `Next:` apply
command containing the resolved exact IDs or `--all`, sorted repeated targets, resolved project
ignore policy when applicable, scope, and fingerprint. An explicit project remains the safe
`--project <project-path>` placeholder backed by the labeled path. JSON output remains structured,
so JSON automation should retain its explicit selection, targets, policy, and scope and submit the
returned fingerprint through `--expect-plan`. Use explicit `--yes` only when automation
intentionally needs a one-command plan-and-apply operation.

Abandoned-lock cleanup is deliberately singular and preview-first:

```sh
skill-sync --json recovery unlock <id> --dry-run
skill-sync --json --no-input recovery unlock <id> --yes
```

Owned advisory locks refresh their persisted lock-file mtime heartbeat every 15 seconds. The first
command must prove that the recorded hostname is this automation host, its PID is no longer active,
and the fixed 60-second crash grace has elapsed from the later of metadata creation and that last
persisted heartbeat. The apply serializes per stable ID with a crash-visible recovery action lock,
then revalidates the exact reviewed path, full owner metadata, grace, and plan fingerprint while
holding it before removing only that lock. Do not add `--project`, `--global`, or `--scope`; unlock
searches by one stable recovery ID and rejects scope flags. Active, foreign-host, too-young,
malformed, changed, missing, or otherwise unverifiable locks fail safely with conflict status `5`
and remain in place. Never replace this workflow with scripted filesystem deletion.

Successful apply syncs the selected lock's parent directory before reporting completion. If that
durability sync is ambiguous, the recovery action lock stays visible for `recovery list` and
inspection, so automation must stop rather than retrying deletion blindly. JSON inspection and
preview results never include the internal `ownerToken`; do not depend on or log it.

For human-readable dry-runs in a redirected terminal or with `--no-input`, the
printed destructive apply step includes `--yes` when confirmation would
otherwise be unavailable. This applies to canonical and group removal,
recovery actions, and uninstalls that require a local-work backup. JSON remains
structured and does not embed human guidance.

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
skill-sync --json doctor --offline
skill-sync --json status --offline
```

If offline status reports that no verified cached revision exists, retry the
same status command without `--offline` when remote access is available. The
offline attempt does not refresh or create an unverified cache.

Reconciliation can use one explicit full commit already in the cache:

```sh
skill-sync --json --no-input update frontend/review-ui --offline <full-commit>
```

Offline results are marked stale and never represented as current with the remote.
