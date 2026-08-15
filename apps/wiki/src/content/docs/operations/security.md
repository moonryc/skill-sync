---
title: Security boundaries
description: Understand what skill-sync validates, executes, writes, and leaves to Git hosting controls.
---

`skill-sync` manages repositories that can contain scripts and instructions, so its runtime treats fetched content as untrusted inert data.

## Content is never executed

Catalog, validation, installation, diff, and reconciliation operations do not run fetched:

- skill scripts or package lifecycle commands;
- Git hooks or configured filters;
- submodules;
- executables discovered inside a skill tree.

The CLI reads files to validate metadata and compute deterministic digests.

## Unsafe trees are rejected

Validation rejects symlinks, special files, nested Git repositories, traversal outside the expected root, nested skill roots, malformed `SKILL.md` front matter, unsafe names, and case-fold collisions. The complete proposed canonical tree is validated before a write is committed.

## Git operations are constrained

Git commands use argument arrays instead of shell interpolation. Canonical writes use isolated hooks and filters, a clean exact-revision checkout, a normal commit, and a non-force push. Windows Git invocations enable long-path support for nested managed content. Authentication remains external in Git credential helpers, SSH, or `gh`; repository URLs containing credentials are refused.

## Project writes stay contained

Target paths resolve beneath the selected project root. Writes are staged, journaled, digest-checked, and atomically replaced where the platform supports it. The managed `.gitignore` block lists exact installed paths instead of granting ownership over whole `.codex` or `.claude` trees.

Reported Git reasons are stripped of terminal controls, flattened, credential-
and token-redacted, and limited to a short excerpt. Other diagnostics also
redact common credential and token forms from reported errors.

## Locks are never silently stolen

Filesystem advisory locks coordinate project, global, configuration, cache, library, and recovery
work across processes. When a lock remains after a crash, skill-sync reports it through `doctor`
and `recovery list`; it does not infer abandonment from age alone and does not silently replace it.

The only automated removal path is singular, preview-first
`skill-sync recovery unlock <id> --dry-run`. Unlock accepts one stable record ID and no
`--project`, `--global`, or `--scope` flag. It requires the recorded hostname to match the current
host and the operating system to prove that the recorded PID is absent. Owned advisory locks
refresh their persisted lock-file mtime heartbeat every 15 seconds. The fixed 60-second crash grace
must elapse from the later of metadata creation and that last persisted heartbeat, giving orphaned
child processes time to exit before the CLI considers removal.

A confirmed apply serializes with a crash-visible recovery action lock derived from the stable
record ID. While holding it, skill-sync revalidates the exact bounded lock path, full owner
metadata, crash grace, and plan fingerprint immediately before deleting only that regular lock
file. It syncs the parent directory before reporting completion. If that sync is ambiguous, the
action lock remains as inspectable recovery evidence instead of being silently released.

Active owners, foreign hosts, locks within that 60-second heartbeat grace, malformed metadata,
changed evidence, symbolic links, and process states that cannot be proven absent are refused and
preserved. Confirm interactively or pass `--yes` only after reviewing the preview. Never manually
delete a lock to bypass these checks. Lock ownership tokens remain internal: JSON inspection and
preview results do not expose `ownerToken`.

## Repository policy is still external

The canonical library is a normal Git repository. The rule “change it through `skill-sync`” is a workflow policy, not something Git can enforce. Direct pushes, web edits, and other Git clients can still alter the repository.

For stronger controls, combine `skill-sync` with:

- private repository visibility;
- least-privilege credentials;
- protected branches and required checks;
- rulesets that restrict who can push;
- normal Git review and recovery practices.

Run [`doctor`](/reference/inspection/#doctor) to inspect applicable runtime and authentication boundaries without making changes.
