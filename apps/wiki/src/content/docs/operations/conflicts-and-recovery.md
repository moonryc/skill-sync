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
skill-sync recovery list
skill-sync recovery inspect <id>
```

The record ID comes from `recovery list`. After inspection, choose the direction that matches the
kind of evidence it reports. For an ordinary record labeled `recoverable`, preview the direction
you want before confirming:

Run list and inspect without `--project` or `--global`; they search the recovery store directly.
Use `recovery list --scope <scope>` to narrow the records. If inspection reports a record owned by
another project, it prints the affected destinations and an action with
`skill-sync --project /path/to/affected-project` before `recovery resume`, `restore`, or `prune`.

```sh
# Finish the originally intended write.
skill-sync recovery resume <id> --dry-run
skill-sync recovery resume <id>

# Or return to the recorded pre-operation state.
skill-sync recovery restore <id> --dry-run
skill-sync recovery restore <id>
```

Both operations revalidate every recorded path and digest. They refuse changed, incomplete,
legacy inspect-only, or otherwise ambiguous evidence instead of guessing.

An advisory lock uses a separate singular recovery path. Only follow it when inspection offers
unlock for that stable lock ID:

```sh
skill-sync recovery unlock <id> --dry-run
skill-sync recovery unlock <id>
# Use --yes only for an explicitly reviewed noninteractive apply.
```

Owned advisory locks refresh their persisted lock-file mtime heartbeat every 15 seconds. The
preview proves that the recorded owner is on this host, its PID is no longer active, and 60 seconds
have elapsed from the later of metadata creation and that last persisted heartbeat, then shows the
exact lock path, owner, scope, and plan fingerprint. Application requires interactive confirmation
or explicit `--yes`. It serializes per stable record with a crash-visible recovery action lock and,
while holding it, revalidates the exact path, owner metadata, grace, and fingerprint immediately
before removing only that lock. Active, foreign-host, too-young, malformed, changed, or otherwise
unverifiable evidence is refused and preserved.

Skill-sync syncs the selected lock's parent directory before reporting the removal as complete. If
that durability step is ambiguous, it preserves the recovery action lock for `recovery list` and
inspection instead of claiming success. JSON inspection and preview show safe owner facts but never
the internal `ownerToken`.

`recovery unlock` searches by one stable ID. Run it without `--project`, `--global`, or `--scope`;
the scope shown in the lock metadata is evidence, not a command selector. Never substitute manual
lock deletion when unlock refuses to prove abandonment.

An initialization record is different. It records provider repository creation, initial push, and
saved-configuration phases as inspect-only evidence. `recovery resume`, `recovery restore`, and
`recovery prune` cannot act on it, and skill-sync never automatically replays or deletes external
repository changes. Inspect the repository and branch with the provider, then run the exact fresh
`skill-sync init ... --dry-run` command printed by `recovery inspect`. If that current plan is
correct, run the exact `--expect-plan` command printed by the preview. A successful setup for the
same remote clears the older matching initialization evidence.

After the project or global state is verified, terminal records and verified backups can be
reviewed and pruned explicitly:

```sh
skill-sync recovery list --include-terminal
skill-sync recovery prune <id> --dry-run
skill-sync recovery prune <id>
```

Prune never accepts unresolved records or advisory locks. Do not manually delete journals, locks,
staging paths, or backups, and keep backups until the associated metadata and target copies have
been checked. See the complete [recovery command reference](/reference/recovery-commands/).

## Partial batches

All target copies for one skill commit atomically, but separate skills are independent. A batch can therefore update one skill and safely stop another. This is a deterministic partial result with exit status `6`; rerun `status`, resolve the remaining item, and repeat the selected operation.
