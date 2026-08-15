---
title: Troubleshooting
description: Diagnose common setup, authentication, validation, reconciliation, and recovery failures.
---

Start with the non-mutating diagnostic command:

```sh
skill-sync doctor
```

Use `doctor --offline` when the network must not be contacted. Each check reports `pass`, `warning`, `fail`, or `skipped` and includes remediation for non-passing results.
The read-only `Recovery state` check still runs offline and in JSON/TUI diagnostics: valid locks,
incomplete journals, or backups are counted as a warning, while malformed or unsafe evidence is a
local failure. Follow its exact `recovery list` and `recovery inspect <id>` handoff; doctor never
repairs or deletes the evidence.

## No default library is configured

Connect an existing remote or create a repository:

```sh
skill-sync init git@github.com:you/ai-skills.git --dry-run
# or create one:
skill-sync init --create you/ai-skills --dry-run
# Then run the exact --expect-plan command printed by the preview.
```

You can also set `SKILL_SYNC_LIBRARY` or persist `library.remote`. Confirm the resolved source with `skill-sync config list`.

## Git authentication fails

- Read the short sanitized Git reason in `REMOTE_ACCESS_FAILED`; `init` reports it before writing
  configuration, cache, staging, or project state.
- Verify the same remote with normal `git ls-remote` or your preferred Git client.
- For HTTPS, configure a Git credential helper or authenticate with the provider. For GitHub, run
  `gh auth login`.
- For SSH, confirm that the intended key is loaded and the host is configured and accessible.
- For GitHub creation, run `gh auth status` and reauthenticate if needed.
- Remove credentials from the URL; keep them in external credential storage.

Authentication and network failures use exit status `4`.

`init --create --dry-run` checks authentication and repository availability
without creating the repository. If a later initialization step fails after
creation, the GitHub repository may remain even though local configuration,
cache, staging, and project state do not describe what happened at the provider.
skill-sync records provider creation, initial push, and saved-configuration
phases as inspect-only recovery evidence. It never automatically replays or
deletes external repository changes.

## A nonempty repository is incompatible

`INCOMPATIBLE_LIBRARY` means Git reached the repository, but its current tree is
not a valid skill-sync library. The command leaves both the remote contents and
your saved library configuration unchanged. Disposable planning also leaves the
persistent cache unchanged.

Next, choose one of these routes:

- Connect a repository that already contains a valid skill-sync library.
- Use an empty repository and confirm initialization.
- Preview a new one with `skill-sync init --create <owner/name> --dry-run`.

If `INIT_PLAN_CHANGED` appears, nothing from that stale setup plan was applied. Run the exact
preview command in the error, review its current facts, and use the new printed `--expect-plan`
command.

Do not erase or reinitialize the nonempty repository to bypass validation.

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

Preview removal before deciding; retain `--global` or `--project <project-path>` when status printed
that scope:

```sh
skill-sync uninstall <group>/<skill> --dry-run
```

## A lock or journal remains after interruption

Start with the read-only record list, then inspect the exact ID it returns:

```sh
skill-sync recovery list
skill-sync recovery inspect <id>
```

For an ordinary journal labeled `recoverable`, preview either `recovery resume <id> --dry-run` or
`recovery restore <id> --dry-run` only when inspection offers that action. Then confirm only the
direction you intend.

For a valid advisory-lock record, preview the separate singular action printed by inspection:

```sh
skill-sync recovery unlock <id> --dry-run
skill-sync recovery unlock <id>
```

Unlock requires interactive confirmation or explicit `--yes`. Owned advisory locks refresh their
persisted lock-file mtime heartbeat every 15 seconds. Unlock removes only that lock after proving
the recorded owner is on this host, its PID is no longer active, and the fixed 60-second crash grace
has elapsed from the later of metadata creation and that last persisted heartbeat. Applies for the
same stable record serialize on a crash-visible recovery action lock; skill-sync rechecks the exact
reviewed path, owner metadata, grace, and fingerprint while holding it. It refuses and preserves
active, foreign-host, too-young, malformed, changed, missing, or otherwise unverifiable locks. Run
unlock with one stable ID and without `--project`, `--global`, or `--scope`, even when the record
describes a project or global scope.

If the selected lock is removed but syncing its parent directory is ambiguous, skill-sync keeps the
recovery action lock as evidence and does not report clean completion. Run `recovery list` again and
inspect the remaining recovery-scope record; do not delete it manually. JSON inspection and unlock
preview output never contains the internal `ownerToken`.

If inspection shows initialization evidence, do not use `resume`, `restore`, or `prune`; those
commands cannot act on that inspect-only record. Check the named repository and branch with the
provider, run the exact fresh `skill-sync init ... --dry-run` command printed by inspection, and
review the new plan. If it is correct, run the exact `--expect-plan` command printed by that
preview. A successful setup for the same remote clears older matching initialization evidence.
External repository changes are never automatically replayed or deleted.

Do not delete application state broadly or remove evidence—including a refused lock—by hand. Keep
backups until the target copies, manifest, and lockfile are consistent. See the
[recovery command reference](/reference/recovery-commands/).

## Offline revision is rejected

`--offline <revision>` requires an exact full commit already present in the local cache. Fetch successfully first, copy the full commit from prior output or state, and retry. An abbreviated or missing commit is never guessed.

## Offline status has no verified cache

`status --offline` never refreshes from the network. If it reports that no verified cached library revision exists, rerun the same status command without `--offline` when remote access is available. A successful online status populates a verified cache for later offline inspection; do not point the command at an unverified directory.

## Automation waits for input or emits usage errors

Put global flags before the command and provide all required choices:

```sh
skill-sync --json --no-input install frontend/review-ui --target codex --gitignore
```

`--yes` only answers ordinary confirmation; it does not substitute for `--discard-local`, `--recursive`, a selector, or a source target. Invalid or incomplete invocations use exit status `2`.

## Node.js is unsupported

Install Node.js 22 or newer, reopen the shell so `node` resolves to that version, and rerun `skill-sync doctor`.
