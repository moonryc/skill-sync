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
skill-sync version
```

Run `skill-sync --help` to list `tui`, `completion`, `self-update`, `init`, `install`, `sync`, `publish`, `status`, and the other setup, library, and project commands. In an interactive terminal, run `skill-sync` or `skill-sync tui` to browse the visual workflow; use argument-driven commands for CI and automation. Run `skill-sync doctor` at any time to inspect the runtime, Git, authentication, configuration, cache, and project state without making repairs.

When the TUI shows that a newer CLI release is available, leave the interface and run:

```sh
skill-sync self-update
```

This explicitly updates the global npm installation. It is separate from the
skill `update` command, which reconciles managed copies.

## Enable shell completion

`completion` requires exactly one of `bash`, `zsh`, `fish`, or `powershell`.
It prints a deterministic static script to stdout without labels or setup
messages. The command does not read or write configuration, cache, project,
global, or profile state; inspect recovery evidence; contact the network; or
edit a shell startup file.

Use the matching current-session command below. For persistence, generate a
separate completion file and review the one startup-file line your shell needs.
The redirections and `Set-Content` examples are explicit user-directed file
writes; `skill-sync completion` itself never writes them.

### Bash

Load completion in the current Bash session:

```sh
source /dev/stdin <<< "$(skill-sync completion --shell bash)"
```

For persistence with a Bash completion loader, save the generated file in its
user completion directory:

```sh
completion_directory="${BASH_COMPLETION_USER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions}"
mkdir -p "$completion_directory"
skill-sync completion --shell bash > "$completion_directory/skill-sync"
```

If the Bash installation does not load that directory automatically, source
the saved file from the startup file it already uses. Do not add a second
completion-loader setup blindly.

### Zsh

Initialize Zsh completion if necessary, then load the current script:

```sh
autoload -Uz compinit
compinit
source <(skill-sync completion --shell zsh)
```

For persistence, save the autoloadable `_skill-sync` file:

```sh
mkdir -p ~/.zfunc
skill-sync completion --shell zsh > ~/.zfunc/_skill-sync
```

Ensure `~/.zfunc` is in `fpath` before the existing `compinit` call in
`~/.zshrc`. Add only the missing lines:

```sh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit
compinit
```

### Fish

Load completion in the current Fish session:

```fish
skill-sync completion --shell fish | source
```

Fish automatically loads completion files from its user completions directory:

```fish
mkdir -p ~/.config/fish/completions
skill-sync completion --shell fish > ~/.config/fish/completions/skill-sync.fish
```

Use `$XDG_CONFIG_HOME/fish/completions` instead when the Fish configuration
directory has been relocated.

### PowerShell

Register completion in the current PowerShell session:

```powershell
skill-sync completion --shell powershell | Out-String | Invoke-Expression
```

For persistence, save the generated script next to the current user's profile:

```powershell
$completionDirectory = Join-Path (Split-Path -Parent $PROFILE) 'completions'
New-Item -ItemType Directory -Force -Path $completionDirectory | Out-Null
$completionFile = Join-Path $completionDirectory 'skill-sync.ps1'
skill-sync completion --shell powershell | Set-Content -Encoding utf8 -Path $completionFile
```

After reviewing the saved file, add this source line to `$PROFILE` yourself:

```powershell
. (Join-Path (Join-Path (Split-Path -Parent $PROFILE) 'completions') 'skill-sync.ps1')
```

Regenerate a persistent completion file after updating the CLI so it reflects
the current typed command registry. For machine inspection instead of sourcing,
run `skill-sync --json completion --shell <shell>`; the versioned result's data
contains `{ "shell": "<shell>", "script": "..." }`.

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
