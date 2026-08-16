---
title: Recovery commands
description: Inspect and safely resolve interrupted skill-sync operations.
---

Recovery is deliberately explicit. When a startup warning, `doctor`, or a blocked mutation reports
recovery evidence, begin with the read-only list command. Do not delete journals, locks, staging
directories, or backups by hand.

```sh
skill-sync recovery list
skill-sync recovery inspect <id>
```

The stable `<id>` comes from `recovery list`. Inspect that record before doing anything else. An
ordinary recoverable record may offer `resume` or `restore`, a valid abandoned-lock record may
offer singular `unlock`, and an initialization record instead prints a manual, preview-first setup
path.

## `recovery list`

List unresolved journals, locks, malformed evidence, and recoverable backups without changing
them.

```text
skill-sync recovery list [options]
```

| Option               | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `--scope <scope>`    | Filter by scope kind, stable scope ID, or displayed scope path. |
| `--include-terminal` | Also show committed and rolled-back journals.                   |

Use the displayed record ID verbatim in the remaining commands. A legacy journal or an interrupted
initialization may be marked `inspect-only`; skill-sync will not guess missing state or replay it.

Human output reports the total, sorts stable IDs, and shows at most 20 records
with an omitted count. It explicitly states that no changes were made and ends
with a directly runnable inspection command using the first displayed ID. An
empty result suggests `doctor` only if another command still reports recovery
evidence. JSON retains every record.

This command searches skill-sync's recovery store directly. It does not accept the root
`--project` or `--global` selectors; use its own `--scope <scope>` option to narrow the results.

## `recovery inspect`

Show one record's owning scope, status, affected destinations, and available actions without
changing it. For project journals, the output includes `--project <affected-project>` on the
preview-first action commands so their recovery root is explicit.

```text
skill-sync recovery inspect <id>
```

If the record changed or disappeared since listing, run `recovery list` again. Inspection remains
available while normal mutations are blocked.

Like `recovery list`, inspection searches by stable ID and rejects `--project` and `--global`.
Apply the project selector only to the resume, restore, or prune command printed by inspection.

Inspection shows at most 20 sorted affected destinations and labels the record
as `recoverable`, `inspect-only`, or `cleanup-only`. It explicitly states that
it made no changes. Recoverable journals explain both choices in plain language:
resume finishes the interrupted operation, while restore returns to the state
before it. A valid lock points to preview-first `recovery unlock <id>`; malformed
or otherwise unverifiable lock evidence remains inspect-only. Terminal journals
and verified backups point to preview-first cleanup.

### Interrupted initialization

Initialization records are always inspect-only. They show what skill-sync knew about three setup
phases: provider repository creation, the initial push, and saving the user configuration. An
`attempted` phase is evidence to investigate, not proof that the provider completed or rejected the
request.

`recovery resume`, `recovery restore`, and `recovery prune` do not act on these records. In
particular, skill-sync never automatically replays or deletes an external repository change.
Instead:

1. Inspect the named repository and branch with the provider.
2. Copy and run the exact fresh `skill-sync init ... --dry-run` command printed by `recovery
inspect`.
3. Review the new plan. If it matches the repository you intend to use, run the exact
   `--expect-plan` command printed by that preview.

A successful setup for the same remote clears older matching initialization evidence. Until then,
keep the record as read-only evidence; do not remove it by hand.

## `recovery unlock`

Remove exactly one abandoned advisory lock only after skill-sync proves that its recorded owner
process is gone from this same host and the fixed 60-second heartbeat-based crash grace has elapsed.

```sh
skill-sync recovery unlock <id> --dry-run
skill-sync recovery unlock <id>
# For an explicitly reviewed noninteractive apply:
skill-sync recovery unlock <id> --yes
```

Start with the explicit `--dry-run`. It shows the exact lock path, recorded operation, PID, host,
scope, dead-process-plus-grace proof, and plan fingerprint without changing the lock. Rerunning
without `--dry-run` asks for interactive confirmation; use `--yes` only when the preview has been
reviewed and a prompt is intentionally unavailable. A non-promptable invocation without `--yes`
returns the preview rather than removing anything.

Unlock is deliberately scope-less. It searches the recovery store by one stable lock ID and does
not accept `--project`, `--global`, or `--scope`, even though the displayed owner metadata names the
affected scope. It never accepts multiple IDs, a filesystem path, or a broad deletion target.

The safety proof is conservative:

- the lock must be a bounded, regular, non-symbolic-link file owned by skill-sync's lock store;
- its recorded hostname must equal the current host;
- the operating system must prove that the recorded PID is no longer active;
- owned advisory locks refresh their persisted lock-file mtime heartbeat every 15 seconds;
- at least 60 seconds must have elapsed from the later of metadata creation and that last persisted
  heartbeat; this fixed crash grace allows orphaned child processes time to exit;
- apply must acquire the crash-visible recovery action lock derived from this stable record ID and,
  while holding it, the exact reviewed path, full owner metadata, grace, and plan fingerprint must
  still match.

The per-record recovery action lock serializes competing applies. Another unlock of the same stable
ID refuses while that action is active; unrelated records remain independently reviewable. After
unlinking the selected lock, skill-sync syncs its parent directory before reporting completion. If
that durability sync is ambiguous, the recovery action lock remains crash-visible as inspectable
evidence instead of being released. Run `recovery list` and inspect that remaining action record;
do not assume the original lock's deletion was durably committed.

An active process, a foreign hostname, fewer than 60 seconds since the later of metadata creation
and the last persisted heartbeat, malformed metadata, a changed or missing lock, or any process
state that cannot be proven absent causes `RECOVERY_UNLOCK_REFUSED`. The selected lock is
preserved. Run `recovery list` and inspect the current evidence again; never bypass the refusal by
manually deleting the lock file.

Lock files contain an internal `ownerToken` for ownership and fingerprint checks. Human output and
JSON `recovery inspect` or unlock preview results expose only the safe owner fields—operation, PID,
hostname, creation time, and scope—and never include that token.

## `recovery resume`

Finish the originally intended operation only when every destination and remaining candidate still
matches the journal evidence.

```sh
skill-sync recovery resume <id> --dry-run
skill-sync recovery resume <id>
```

For a record owned by another project, use
`skill-sync --project /path/to/affected-project recovery resume <id> --dry-run` and the equivalent
apply command.

The preview is read-only. Applying the plan requires interactive confirmation, or both `--no-input`
and `--yes` in an explicitly reviewed automation flow. A changed path or plan fingerprint stops the
operation instead of guessing.

Human preview and completion output labels scope, record, operation, current or
final state, and plan fingerprint. It translates recorded action codes into
plain language, displays at most 20 sorted destinations with an omitted count,
and ends with the exact apply or scope-correct status command. JSON retains the
unchanged structured plan and complete entry list.
When a human preview is produced without prompt capability, that exact apply
command includes `--yes` so it does not fail at the confirmation boundary.

Before matching the record, planning, or taking its scope lock, the CLI resolves the selected
project root (the explicit `--project` path or discovered Git root) to its canonical filesystem
path. A symlink alias therefore selects the same recovery scope and lock. Global recovery uses the
canonical home root.

## `recovery restore`

Return to the recorded pre-operation state only when rollback artifacts and destinations still
match the journal.

```sh
skill-sync recovery restore <id> --dry-run
skill-sync recovery restore <id>
```

For a record owned by another project, put
`--project /path/to/affected-project` before `recovery restore` as shown above.

Restore uses the same preview, confirmation, digest revalidation, and locking rules as resume. It
refuses legacy inspect-only or ambiguous evidence, and canonicalizes the selected root in the same
way.

Restore uses the same bounded, plain-language human plan format as resume and
ends with the applicable apply or managed-state verification command.

## `recovery prune`

Remove selected terminal journals or verified recoverable backups after the resulting project or
global state has been checked.

```sh
skill-sync recovery list --include-terminal
skill-sync recovery prune <id> [<id>...] --dry-run
skill-sync recovery prune <id> [<id>...]
```

Prune requires confirmation and operates only on paths proven to belong to the selected records.
It refuses unresolved, failed, malformed, foreign, or inspect-only evidence. Never use broad manual
deletion as a substitute. Prune does not remove advisory locks; use singular preview-first
`recovery unlock <id>` only when its same-host dead-process proof and fixed 60-second
heartbeat-based crash grace succeed.

Human prune output reports selected-record and owned-path counts, shows at most
20 sorted proven-owned paths, reports omissions, and ends with the apply or
verification step. For a large selection, it says to rerun the same selection
without `--dry-run` instead of printing an unbounded or misleading placeholder;
the handoff also names `--yes` when prompts are unavailable.
JSON retains every selected record and path.

For a project-owned record outside the current directory, use the `--project <affected-project>`
placement printed by inspection. `recovery prune` also accepts `--global` when explicitly selecting
global managed state; list and inspect do not. Prune canonicalizes that selected root before it
matches records or removes any proven-owned artifact.

See [conflicts and recovery](/operations/conflicts-and-recovery/) for the decision workflow and
[troubleshooting](/troubleshooting/) for setup and authentication diagnostics.
