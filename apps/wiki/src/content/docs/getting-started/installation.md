---
title: Installation
description: Install skill-sync and prepare Git access for your canonical skill library.
---

## Requirements

- Node.js 22 or newer
- Git available on `PATH`
- Git credentials or an SSH agent that can read and write the library repository
- Optional: the GitHub CLI (`gh`) when using `init --create`

## Install the CLI

Install `skill-sync` globally with npm:

```sh
npm install --global @moonryc/skill-sync
skill-sync --help
```

The help command should list `tui`, `init`, `install`, `sync`, `publish`, `status`, and the other library and project commands. In an interactive terminal, run `skill-sync` or `skill-sync tui` to browse the visual workflow; use argument-driven commands for CI and automation. Run `skill-sync doctor` at any time to inspect the runtime, Git, authentication, configuration, cache, and project state without making repairs.

## Prepare Git authentication

`skill-sync` accepts HTTPS and SSH Git remotes. Authentication stays in your normal Git credential helper, SSH agent, or GitHub CLI session; credentials must not be embedded in a remote URL.

For SSH, verify that your agent can reach GitHub:

```sh
ssh -T git@github.com
```

For GitHub repository creation over the CLI, authenticate `gh` first:

```sh
gh auth login
```

Plain `http://` remote input is upgraded to HTTPS. Repository content is treated as inert data: fetched scripts, package lifecycle commands, hooks, filters, and submodules are not run.

## Choose a project root

Project commands normally discover the repository from your current directory. Use the global `--project <path>` option when you need to operate on another root explicitly:

```sh
skill-sync --project /path/to/project status
```

For skills that should be available across projects, use the separate explicit
global scope instead. It uses `~/.codex/skills` and `~/.claude/skills`, keeps
its state in skill-sync's user-state directory, and cannot be combined with
`--project`:

```sh
skill-sync --global install frontend/review-ui --target codex
skill-sync --global doctor
```

Next, [connect or create your library in the quick start](/getting-started/quick-start/).
