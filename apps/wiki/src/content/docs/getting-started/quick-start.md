---
title: Quick start
description: Connect a Git library, add a skill, and install it into Codex and Claude.
---

This walkthrough establishes the normal `skill-sync` loop: connect a canonical library, add validated content, install selected copies, and reconcile later changes.

## 1. Connect a library

Connect an existing compatible repository:

```sh
skill-sync init git@github.com:you/ai-skills.git
```

An empty remote requires confirmation before `skill-sync` initializes the library structure. To create a private GitHub repository instead:

```sh
gh auth login
skill-sync init --create you/ai-skills --transport ssh
```

Private visibility is the default for `--create`. Use `--visibility public` or `--visibility internal` only when that is intentional.

## 2. Add a local skill

A skill is a directory containing a valid `SKILL.md`. Add it to the canonical library, optionally under a group:

```sh
skill-sync add ./review-ui --group frontend
skill-sync list
```

`add` refuses an existing qualified ID. To send edits for an already tracked skill back to the library, use `publish` instead.

## 3. Install into a project

From the destination project, install the skill into one or more agents:

```sh
cd /path/to/project
skill-sync install frontend/review-ui \
  --target codex \
  --target claude \
  --gitignore
```

This creates managed copies at `.codex/skills/review-ui` and `.claude/skills/review-ui`, records intent in `skill-sync.json`, and records exact revisions and digests in `skill-sync.lock.json`.

Use `--dry-run` before any mutating command when you want to inspect destinations, state changes, conflicts, and backup requirements without writing.

## 4. Inspect and synchronize

Check project state before applying canonical updates:

```sh
skill-sync status
skill-sync diff frontend/review-ui
skill-sync sync --check
skill-sync sync
```

Safe outdated or missing copies can be refreshed. Local-only edits are preserved, and simultaneous local and canonical changes stop as conflicts instead of being overwritten.

## 5. Publish intentional edits

When a managed project copy contains edits that should become canonical:

```sh
skill-sync publish frontend/review-ui --from codex --dry-run
skill-sync publish frontend/review-ui --from codex
```

If Codex and Claude copies diverge, `--from` is required so the source is explicit. Canonical writes validate the entire resulting library, create a normal Git commit, and push without force.

Continue with [library concepts](/concepts/library-model/) or browse [common workflows](/guides/project-workflows/).
