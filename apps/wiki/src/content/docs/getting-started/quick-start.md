---
title: Quick start
description: Connect a Git library and install an existing skill into Codex or Claude.
---

This walkthrough follows the common consumer path: connect a canonical library, browse existing
skills, install selected copies, and reconcile later changes. Adding or publishing canonical
content is an optional author workflow.

## 1. Connect a library

Connect an existing compatible repository:

```sh
skill-sync init git@github.com:you/ai-skills.git --dry-run
# Then run the exact --expect-plan command printed by the preview.
```

An empty remote requires confirmation before `skill-sync` initializes the library structure. To create a private GitHub repository instead:

```sh
gh auth login
skill-sync init --create you/ai-skills --transport ssh --dry-run
# Then run the exact --expect-plan command printed by the preview.
```

Private visibility is the default for `--create`. Use `--visibility public` or `--visibility internal` only when that is intentional.

The preview validates the repository and current configuration using disposable temporary storage;
it does not write the cache, configuration, or remote. The printed fingerprint prevents apply from
using a plan that changed after review. You can also run `skill-sync` with no subcommand for the
guided setup screen, which uses this same preview and apply path.

The examples above are intentionally preview-first. If you run a direct `skill-sync init ...`
without `--dry-run`, `--expect-plan`, or `--yes`, skill-sync still creates the plan first. In an
interactive terminal it prints the plan and asks whether to apply it. If confirmation is unavailable
because input is disabled, output is JSON, the terminal is redirected, or the command runs in CI,
it returns the preview and makes no setup changes. The exact `--expect-plan` command printed by the
preview applies the reviewed plan. Use explicit `--yes` only when automation intentionally needs to
plan and apply in one command.

The guided create action is labeled `Create GitHub library (starts empty)`. A
connected library that already has skills opens the catalog and teaches `Space`
selection followed by `i` to review installation. An empty result remains on the
overview and points to the write-free author preview
`skill-sync add <path> --dry-run` instead of opening an unusable catalog.

There are no top-level `setup` or `create` commands. If you try one, skill-sync
makes no changes and points to the matching `init` command above.

## 2. Browse the library

List the available qualified skill IDs before choosing one:

```sh
skill-sync list
skill-sync list --query review
```

If the library is empty and you maintain it, skip to [Add the first library
skill](#optional-add-the-first-library-skill). Consumers do not need to author local skill content.

## 3. Install into a project

From the destination project, install the skill into one or more agents:

```sh
cd /path/to/project
skill-sync status
skill-sync install frontend/review-ui \
  --target codex \
  --target claude \
  --gitignore \
  --dry-run
# Then run the exact --expect-plan command printed by the preview.
```

Before the first installation, and again after the final managed skill is removed, `status`
succeeds with an empty managed-state summary. It suggests `init` if the setup step has not been
completed, otherwise `list` and its complete preview-ready install command. Installation creates
managed copies at `.codex/skills/review-ui` and
`.claude/skills/review-ui`, records intent in `skill-sync.json`, and records exact revisions and
digests in `skill-sync.lock.json`.

To authorize only the exact plan you reviewed, copy the complete `Next: skill-sync ...` apply
command printed by the human preview. Do not rebuild it from memory: skill-sync includes the exact
resolved qualified IDs (or `--all`), sorted repeated targets, project/global scope, and fingerprint.
For project scope it also includes the resolved ignore policy. For example, the handoff from this
preview has the following shape:

```sh
skill-sync install frontend/review-ui --target codex --gitignore --dry-run
skill-sync install frontend/review-ui --target codex --gitignore --expect-plan <fingerprint>
```

If the preview was invoked with an explicit project, its `Next:` command keeps the safe
`--project <project-path>` placeholder. Replace that placeholder with the labeled project path shown
in the preview; skill-sync does not interpolate filesystem paths into executable shell guidance.

The preview writes nothing. If the library revision, scope, destination content, state, or
`.gitignore` plan changes, the second command reports `INSTALL_PLAN_CHANGED` before staging,
journaling, or changing managed content or state. Review the new fingerprint rather than forcing
the old plan.

A direct install with neither `--expect-plan` nor explicit `--yes` still plans first. Interactive
use prints that plan and asks before applying it. If confirmation is unavailable because input is
disabled, output is JSON, the terminal is redirected, or the command runs in CI, it returns a
cache-only preview and makes no project or global writes. Use explicit `--yes` only when automation
intentionally needs to plan and apply in one command.

Use `--dry-run` before other mutating commands when you want to inspect destinations, state changes,
conflicts, and backup requirements without writing.

## 4. Inspect and synchronize

Check project state before applying canonical updates:

```sh
skill-sync status
skill-sync diff frontend/review-ui
skill-sync sync --check
skill-sync sync
```

Safe outdated or missing copies can be refreshed. Local-only edits are preserved, and simultaneous local and canonical changes stop as conflicts instead of being overwritten.

## Optional: add the first library skill

Library authors can add a local directory that already contains a valid `SKILL.md`, optionally
under a group:

```sh
skill-sync add ./review-ui --group frontend
skill-sync list
```

`add` refuses an existing qualified ID. It is not required when you only install from a populated
library.

## 5. Publish intentional edits

When a managed project copy contains edits that should become canonical:

```sh
skill-sync publish frontend/review-ui --from codex --dry-run
skill-sync publish frontend/review-ui --from codex
```

If Codex and Claude copies diverge, `--from` is required so the source is explicit. Canonical writes validate the entire resulting library, create a normal Git commit, and push without force.

Continue with [library concepts](/concepts/library-model/) or browse [common workflows](/guides/project-workflows/).
