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

Git commands use argument arrays instead of shell interpolation. Canonical writes use isolated hooks and filters, a clean exact-revision checkout, a normal commit, and a non-force push. Authentication remains external in Git credential helpers, SSH, or `gh`; repository URLs containing credentials are refused.

## Project writes stay contained

Target paths resolve beneath the selected project root. Writes are staged, journaled, digest-checked, and atomically replaced where the platform supports it. The managed `.gitignore` block lists exact installed paths instead of granting ownership over whole `.codex` or `.claude` trees.

Diagnostics redact common credential and token forms from reported errors.

## Repository policy is still external

The canonical library is a normal Git repository. The rule “change it through `skill-sync`” is a workflow policy, not something Git can enforce. Direct pushes, web edits, and other Git clients can still alter the repository.

For stronger controls, combine `skill-sync` with:

- private repository visibility;
- least-privilege credentials;
- protected branches and required checks;
- rulesets that restrict who can push;
- normal Git review and recovery practices.

Run [`doctor`](/reference/inspection/#doctor) to inspect applicable runtime and authentication boundaries without making changes.
