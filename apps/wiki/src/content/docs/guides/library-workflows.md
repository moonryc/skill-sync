---
title: Library workflows
description: Connect, create, curate, organize, publish, and remove canonical skills.
---

Library commands change the canonical Git repository. Use `--dry-run` where available, and keep the library remote protected like any other source repository.

## Connect an existing repository

```sh
skill-sync init git@github.com:you/ai-skills.git
```

Use `--branch <branch>` when the library lives on a non-default branch. The remote may use HTTPS or SSH, but credentials cannot be embedded in its URL. When the remote is empty, initialization requires confirmation before creating the library metadata and skill root.

## Create a GitHub repository

```sh
skill-sync init \
  --create you/ai-skills \
  --visibility private \
  --transport ssh \
  --branch main
```

Repository creation requires an authenticated `gh` installation. `--visibility` accepts `private`, `public`, or `internal`; `--transport` accepts `https` or `ssh`. Those two options apply only with `--create`.

## Add a new skill

Validate and preview a local skill before adding it:

```sh
skill-sync validate ./review-ui
skill-sync add ./review-ui --group frontend --dry-run
skill-sync add ./review-ui --group frontend
```

The source directory must be outside the canonical checkout and contain a valid `SKILL.md`. `add` creates a new ID only. If `frontend/review-ui` already exists, edit a tracked project copy and use `publish`.

## Publish edits to existing skills

```sh
skill-sync status
skill-sync diff frontend/review-ui
skill-sync publish frontend/review-ui --from codex --dry-run
skill-sync publish frontend/review-ui --from codex
```

You may pass several IDs or `--all`. When multiple installed targets for the same skill differ, `--from codex` or `--from claude` identifies the intended source. Publishing validates the complete library result and stops on unsafe remote races.

## Organize groups

```sh
skill-sync group list
skill-sync group create frontend
skill-sync group rename frontend user-interface
skill-sync group remove frontend
```

`group create` writes an explicit marker so an empty group persists. Rename moves the full subtree and reports every affected qualified skill ID. A nonempty group cannot be removed unless both `--recursive` and confirmation are provided:

```sh
skill-sync group remove legacy --recursive --dry-run
skill-sync group remove legacy --recursive
```

`--yes` can answer the confirmation but does not replace `--recursive`.

## Remove a canonical skill

```sh
skill-sync library remove frontend/review-ui --dry-run
skill-sync library remove frontend/review-ui
```

Removal requires confirmation. Existing project copies remain on disk and become orphaned so that canonical deletion does not silently delete local files. Use normal Git history if the library content must be restored.

## Inspect before and after

Use these read-only commands around library changes:

```sh
skill-sync list --group frontend
skill-sync info frontend/review-ui
skill-sync validate frontend/review-ui
skill-sync doctor
```

For exact arguments and options, see the [library command reference](/reference/library-commands/).
