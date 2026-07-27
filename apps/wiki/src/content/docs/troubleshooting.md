---
title: Troubleshooting
description: Diagnose common setup, authentication, validation, reconciliation, and recovery failures.
---

Start with the non-mutating diagnostic command:

```sh
skill-sync doctor
```

Use `doctor --offline` when the network must not be contacted. Each check reports `pass`, `warning`, `fail`, or `skipped` and includes remediation for non-passing results.

## No default library is configured

Connect an existing remote or create a repository:

```sh
skill-sync init git@github.com:you/ai-skills.git
```

You can also set `SKILL_SYNC_LIBRARY` or persist `library.remote`. Confirm the resolved source with `skill-sync config list`.

## Git authentication fails

- Verify the same remote with normal `git ls-remote` or your preferred Git client.
- For SSH, confirm that the agent has the intended key and host access.
- For GitHub creation, run `gh auth status` and reauthenticate if needed.
- Remove credentials from the URL; keep them in external credential storage.

Authentication and network failures use exit status `4`.

## A skill fails validation

Run the validator directly on the narrowest input:

```sh
skill-sync validate ./local-skill
```

Check for a missing or malformed `SKILL.md`, unsafe names, symlinks, special files, nested repositories, nested skill roots, path traversal, and case-insensitive collisions. Validation failures use exit status `3` and do not write partial canonical content.

## An update refuses to overwrite files

This is expected when local work could be lost.

```sh
skill-sync status
skill-sync diff <id>
```

Publish intentional local work. If replacement is intentional, preview and then provide `--discard-local`; a confirmation is still required. See [conflicts and recovery](/operations/conflicts-and-recovery/).

## Two skills collide at one target

Targets use the leaf skill name, so `frontend/review-ui` and `legacy/review-ui` both map to `review-ui`. Install only one into that project or rename/reorganize the canonical IDs so target paths are unique.

## A managed skill is orphaned

The canonical ID was removed while the project copy remained. Decide whether to keep the unmanaged content, uninstall the tracked copy, or restore the canonical skill from Git history. `sync` will not silently delete it.

## A lock or journal remains after interruption

Verify no `skill-sync` process is running, then follow the exact remediation reported by `doctor`. Do not delete application state broadly. Keep backups until the target copies, manifest, and lockfile are consistent.

## Offline revision is rejected

`--offline <revision>` requires an exact full commit already present in the local cache. Fetch successfully first, copy the full commit from prior output or state, and retry. An abbreviated or missing commit is never guessed.

## Automation waits for input or emits usage errors

Put global flags before the command and provide all required choices:

```sh
skill-sync --json --no-input install frontend/review-ui --target codex --gitignore
```

`--yes` only answers ordinary confirmation; it does not substitute for `--discard-local`, `--recursive`, a selector, or a source target. Invalid or incomplete invocations use exit status `2`.

## Node.js is unsupported

Install Node.js 22 or newer, reopen the shell so `node` resolves to that version, and rerun `skill-sync doctor`.
