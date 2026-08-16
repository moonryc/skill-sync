# skill-sync

Keep one Git-backed library of reusable AI skills and install exactly the skills each Codex or
Claude project needs.

`skill-sync` is a command-line tool, not a JavaScript API. It gives you a validated, versioned
source of truth for skills while keeping project and user-level copies explicit and reviewable.

[Documentation](https://skill-sync.ryanmoon.xyz/) ·
[GitHub](https://github.com/moonryc/skill-sync) ·
[Report an issue](https://github.com/moonryc/skill-sync/issues)

## What it does

- Organizes reusable skills in a Git repository with portable group and skill IDs.
- Installs selected skills into Codex, Claude, or both.
- Supports project-local and user-level global skill collections.
- Previews writes before applying them and binds approved installs to an exact plan.
- Detects local edits, upstream changes, conflicts, missing files, and orphaned skills.
- Publishes intentional edits back to the canonical library without force-pushing.
- Provides an interactive terminal UI and deterministic JSON commands for automation.

## Requirements

- Node.js 22 or newer
- Git available on `PATH`
- HTTPS credentials or an SSH agent that can access your skill library
- Optional: GitHub CLI (`gh`) when creating a library with `init --create`

## Install

```sh
npm install --global @moonryc/skill-sync
skill-sync version
```

Run `skill-sync` with no subcommand to open the guided terminal interface, or use
`skill-sync --help` to explore the command-line workflows.

## Quick start

### 1. Connect your library

Connect an existing compatible repository:

```sh
skill-sync init git@github.com:you/ai-skills.git --dry-run
```

The preview makes no persistent changes. Review it, then run the exact `--expect-plan` command
printed under `Next:`. If the repository or configuration changed in the meantime, skill-sync
refuses the old plan and asks you to review a new one.

To create a private GitHub library instead:

```sh
gh auth login
skill-sync init --create you/ai-skills --transport ssh --dry-run
```

Private visibility is the default. The preview explains the repository, branch, transport, and
local configuration effects before anything is created.

### 2. Browse and install a skill

```sh
skill-sync list

cd /path/to/project
skill-sync status
skill-sync install frontend/review-ui \
  --target codex \
  --target claude \
  --gitignore \
  --dry-run
```

Review the destinations and state changes, then copy the exact `--expect-plan` command printed by
the preview. Installed project copies live under `.codex/skills` and `.claude/skills`; skill-sync
records their intended IDs and exact canonical revisions in the project.

### 3. Keep installed skills current

```sh
skill-sync status
skill-sync diff frontend/review-ui
skill-sync sync --check
skill-sync sync
```

Safe upstream changes are applied. Local-only edits are preserved, and simultaneous local and
canonical changes stop as conflicts instead of being overwritten.

## Interactive command center

```sh
skill-sync
# or
skill-sync tui
```

Use the terminal UI to connect or create a library, review managed-skill health, browse groups,
search skills, choose Codex and Claude targets, review installations and synchronization, and add
or adopt eligible on-disk skills. Press `/` for search mode, `f` for the group chooser, `c` to
clear filters, and `?` for contextual help. Managed details explain each state and provide exact
diff/update handoffs. Sync uses a dry-run review showing revision, freshness, actions, writes,
backups, and blocked entries, then revalidates its review fingerprint before applying. Diagnostics
remain available from the normal overview. The TUI stays read-only until you confirm a reviewed
action. During work, Ctrl+C requests cooperative cancellation and waits for the command's safe
commit boundary.

## User-level global skills

Use the explicit `--global` scope for skills that should be available across projects:

```sh
skill-sync list --global
skill-sync --global install frontend/review-ui --target codex --dry-run
skill-sync --global status
```

Global installs use your Codex and Claude user skill directories. They do not create project state
or modify a project's `.gitignore`.

## Author a library

Add a local directory that contains a valid `SKILL.md`:

```sh
skill-sync add ./review-ui --group frontend --dry-run
```

Publish intentional edits from a managed project copy back to an existing canonical skill:

```sh
skill-sync publish frontend/review-ui --from codex --dry-run
```

Library writes validate the complete result, create a normal Git commit, and push without force.
If another writer changed the content you reviewed, the operation stops.

## Common commands

| Command                     | Purpose                                                               |
| --------------------------- | --------------------------------------------------------------------- |
| `skill-sync list`           | Browse the canonical skill catalog.                                   |
| `skill-sync info <id>`      | Inspect one skill's metadata and file inventory.                      |
| `skill-sync install <id>`   | Install a selected skill into a project or global scope.              |
| `skill-sync status`         | Classify managed copies and show the next safe action.                |
| `skill-sync diff <id>`      | Compare local and canonical content digests.                          |
| `skill-sync sync`           | Reconcile all safely updateable managed skills.                       |
| `skill-sync update <id>`    | Reconcile selected managed skills.                                    |
| `skill-sync publish <id>`   | Publish an intentional local edit to the library.                     |
| `skill-sync uninstall <id>` | Review removal of a managed copy.                                     |
| `skill-sync validate`       | Validate a library, canonical skill, or local skill directory.        |
| `skill-sync doctor`         | Diagnose runtime, Git, authentication, state, and destination issues. |
| `skill-sync recovery list`  | Inspect crash-visible recovery evidence and backups.                  |
| `skill-sync self-update`    | Update the globally installed CLI from npm.                           |

Run `skill-sync <command> --help` for accepted options, examples, safety notes, and command-specific
documentation. Most argument-driven commands support `--json` for one versioned machine-readable
result.

## Safety model

- Repository content is treated as data. Fetched scripts, hooks, filters, lifecycle commands, and
  submodules are not executed.
- Mutating workflows support `--dry-run`; exact install and setup previews print a fingerprint-bound
  apply command.
- Destructive replacement requires explicit intent and creates recoverable backups where needed.
- Project writes are contained beneath the resolved project root and use staged, journaled writes.
- Git operations use normal commits and never force-push.
- Credentials stay in Git helpers, SSH, or `gh`; credential-bearing remote URLs are rejected.

## Shell completion

Generate completion for Bash, Zsh, Fish, or PowerShell:

```sh
skill-sync completion --shell bash
skill-sync completion --shell zsh
skill-sync completion --shell fish
skill-sync completion --shell powershell
```

The command prints a deterministic completion script and never edits your shell profile.

## Documentation and support

- [Documentation home](https://skill-sync.ryanmoon.xyz/)
- [Installation guide](https://skill-sync.ryanmoon.xyz/getting-started/installation/)
- [Quick start](https://skill-sync.ryanmoon.xyz/getting-started/quick-start/)
- [Command reference](https://skill-sync.ryanmoon.xyz/reference/)
- [Troubleshooting](https://skill-sync.ryanmoon.xyz/troubleshooting/)
- [Report an issue](https://github.com/moonryc/skill-sync/issues)

## License

MIT
