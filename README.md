# skill-sync

`skill-sync` is a globally installed CLI for keeping reusable AI skills in one
GitHub repository and projecting selected skills into Codex and Claude project
folders or user-level global directories. The canonical library is grouped,
versioned by Git, validated before every write, and changed through explicit CLI
commands.

## Requirements and installation

- Node.js 22 or newer
- Git on `PATH`
- Git credentials or an SSH agent that can access the library repository
- Optional: the GitHub CLI (`gh`) for `init --create`

```sh
npm install --global @moonryc/skill-sync
skill-sync --help
```

The package uses both HTTPS and SSH Git remotes. Plain HTTP input is upgraded to
HTTPS, credentials must not be embedded in URLs, and authentication remains in
Git credential helpers, SSH, or `gh`.

## Quick start

Connect an existing compatible repository:

```sh
skill-sync init git@github.com:you/ai-skills.git
```

Or create a private GitHub repository (the default visibility):

```sh
gh auth login
skill-sync init --create you/ai-skills --transport ssh
```

Add a local skill to a group, browse the catalog, and install it into a project:

```sh
skill-sync add ./review-ui --group frontend
skill-sync list
cd /path/to/project
skill-sync install frontend/review-ui --target codex --target claude --gitignore
```

Later, pull safe canonical changes with `skill-sync sync`. Use `status` and
`diff` before deciding whether to discard local changes or publish them.

To make a skill available at user level instead, select the explicit global
scope. It writes no project metadata and never changes a project's `.gitignore`:

```sh
skill-sync --global install frontend/review-ui --target codex
skill-sync --global status
```

## Interactive workflow

In an interactive terminal, run `skill-sync` with no subcommand—or use the
explicit `skill-sync tui` command—to open a colorful keyboard-driven command
center. Browse groups, search skills, select Codex and Claude targets, review
an install, inspect managed-state badges, and see valid on-disk skills that are
not tracked by the selected project or global state.

The TUI is read-only until a reviewed install, synchronization, or unmanaged
skill adoption is confirmed. An adoptable inventory entry requires a separately
chosen exact qualified library ID and an exact content match; adoption records
state only and never replaces target files. Viewing an unmanaged skill never
adopts, overwrites, publishes, or deletes it. Use regular commands for pipes,
CI, `--json`, `--no-input`, and deterministic offline workflows.

## Canonical library layout

```text
.skill-sync/
  library.json
skills/
  format-code/
    SKILL.md
  frontend/
    .skill-sync-group.json
    review-ui/
      SKILL.md
      references/
      scripts/
```

Directories below `skills/` are groups until a directory containing `SKILL.md`
is found. A skill is then a leaf and is identified by its complete path, such as
`frontend/review-ui`. Lowercase portable group and skill names are required.
Duplicate leaf names may exist in different groups, but an unqualified selector
works only when it is unambiguous.

Project copies are installed at `.codex/skills/<leaf-name>` and
`.claude/skills/<leaf-name>`. Global copies use `~/.codex/skills/<leaf-name>`
and `~/.claude/skills/<leaf-name>` on supported platforms. Projects record
intent in `skill-sync.json` and exact revisions and digests in
`skill-sync.lock.json`; global state is stored separately under skill-sync's
user state directory as `global/skill-sync.json` and
`global/skill-sync.lock.json`.

## Commands

Every command accepts `--json`, `--no-color`, and `--no-input`. Project-like
commands also accept `--project <path>` or the mutually exclusive `--global`.
Global scope is supported by `install`, `adopt`, `sync`, `update`, `status`,
`diff`, `uninstall`, `list`, `info`, and `doctor`; it is always explicit. JSON mode
disables prompts and emits exactly one versioned object. In automation, provide
every required selector and choice explicitly.

### Library connection and mutation

| Command                      | Purpose and important options                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init [url]`                 | Connect a compatible HTTPS or SSH remote. An empty remote requires confirmation. Option: `--branch`. `--transport` and `--visibility` are create-only.             |
| `init --create <owner/name>` | Create and initialize a GitHub repository. Options: `--visibility private\|public\|internal`, `--transport`, `--branch`.                                           |
| `add <path>`                 | Validate and add a new canonical skill. Options: `--group <path>`, `--dry-run`. Existing IDs are refused; use `publish` for updates.                               |
| `publish [ids...]`           | Publish edits from tracked project copies to existing canonical skills. Options: `--all`, `--from codex\|claude`, `--dry-run`. Divergent targets require `--from`. |
| `library remove <id>`        | Delete one canonical skill after confirmation. Project copies remain installed and become orphaned. Option: `--dry-run`.                                           |
| `group list`                 | List explicit library groups.                                                                                                                                      |
| `group create <group>`       | Create a persistent group marker.                                                                                                                                  |
| `group rename <from> <to>`   | Move a group subtree and report affected qualified IDs.                                                                                                            |
| `group remove <group>`       | Remove an empty group. `--recursive` is required for a nonempty group and does not replace confirmation. Option: `--dry-run`.                                      |

Library writes use a clean exact-revision checkout, validate the complete
result, create a normal commit, and push without force. If another writer
changes touched content, the command stops instead of overwriting it.

### Project installation and reconciliation

| Command              | Purpose and important options                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tui`                | Open the interactive command center. The same interface starts for a bare interactive `skill-sync` invocation; it is unavailable with `--json` or `--no-input`.                                                                            |
| `install [ids...]`   | Install selected skills from one library revision. Options: `--all`, repeated `--target codex\|claude`, `--gitignore`/`--no-gitignore`, `--dry-run`. With `--global`, destinations and state are user-level and `.gitignore` is unchanged. |
| `adopt <id>`         | Track one exact existing unmanaged target copy. Requires `--target codex\|claude`; validates the local directory against the exact qualified canonical ID and writes state only. Option: `--dry-run`; supports `--global`.                 |
| `sync`               | Pull all safely reconcilable tracked skills. Options: `--check`, `--dry-run`, `--discard-local`, `--offline <full-commit>`. Add `--global` for user-level copies.                                                                          |
| `update [ids...]`    | Pull selected tracked skills. Options: `--all`, `--dry-run`, `--discard-local`, `--offline <full-commit>`. `update --all` is equivalent to `sync`; add `--global` for user-level copies.                                                   |
| `uninstall [ids...]` | Remove only selected managed copies. Options: `--all`, `--discard-local`, `--dry-run`; add `--global` for user-level copies.                                                                                                               |

`install` never acts as an update, while `sync` and `update` never publish.
Destructive replacement requires the explicit `--discard-local` option and a
separate confirmation. `--yes` can answer a confirmation but cannot substitute
for `--discard-local` or `--recursive`. Before discarding modified copies, the
CLI creates a recoverable backup in its application state directory.

`--dry-run` reports destinations, state, ignore-file changes, conflicts, and
backup requirements without changing the project or cache. `sync --check`
returns drift information without applying it. `--offline <revision>` is an
explicit exact cached commit; offline results are marked stale and are never
reported as current with the remote.

### Inspection and troubleshooting

| Command                 | Purpose and important options                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                  | List grouped catalog entries. Repeatable filters: `--group`, `--query`, `--agent`, `--state`.                                                                                                                 |
| `info <id>`             | Show validated metadata, revision, digest, and file inventory without printing file bodies.                                                                                                                   |
| `status`                | Classify tracked copies as current, outdated, locally modified, conflicted, missing, orphaned, or colliding. Option: `--offline`; add `--global` for user-level state.                                        |
| `diff <id>`             | Show target-specific local/canonical digest changes for one tracked skill. Add `--global` for user-level state.                                                                                               |
| `validate [id-or-path]` | Validate the configured library, a canonical or installed skill, or an explicit local skill directory. Nothing is executed.                                                                                   |
| `doctor`                | Run all applicable runtime, Git, GitHub CLI, authentication, config, cache, schema, state, and destination checks. Its human report groups clear statuses and next actions. Options: `--offline`, `--global`. |

`doctor --offline` performs no network operation. Its human report identifies
scope and offline mode, groups `pass`, `warning`, `fail`, and `skipped` checks,
and lists next actions for warnings and failures. `--no-color` keeps the same
information without ANSI styling; `--json` retains the structured report. It
never repairs or creates state.

### Configuration

```sh
skill-sync config path
skill-sync config list
skill-sync config get library.remote
skill-sync config set defaults.targets codex,claude
skill-sync config unset defaults.gitignore
```

Supported keys are `library.remote`, `library.branch`, `library.transport`,
`defaults.targets`, and `defaults.gitignore`. Precedence is command option,
environment, user config, then built-in default. Useful environment variables:

- `SKILL_SYNC_LIBRARY`
- `SKILL_SYNC_BRANCH`
- `SKILL_SYNC_TRANSPORT`
- `SKILL_SYNC_TARGETS` (comma-separated)
- `SKILL_SYNC_GITIGNORE` (`manage` or `leave`)
- `SKILL_SYNC_CONFIG_HOME` (isolated config/cache/state root)
- `NO_COLOR`

Configuration contains no credentials and is written atomically. Platform
defaults follow macOS Application Support/Caches, Windows AppData, and the XDG
directories on Linux.

## Conflict and recovery model

Each managed copy is compared three ways: its recorded base digest, current
local digest, and fetched canonical digest. Safe outdated and missing copies can
be pulled. Local-only edits are preserved, while simultaneous local and
canonical changes are reported as conflicts. A batch commits all target copies
of one skill atomically; independent skills may produce a deterministic partial
result.

If a process is interrupted, operation journals, locks, and backups remain
visible. The next CLI startup and `doctor` report safe remediation rather than
silently deleting or replaying them. Keep backups until the associated project
state and copies are verified. Git history is the recovery mechanism for
canonical library deletions.

## Security boundaries

- Repository content is treated as inert data. The CLI does not run fetched
  scripts, hooks, filters, package lifecycle commands, or submodules.
- Skill trees reject symlinks, special files, nested Git repositories, path
  traversal, nested skill roots, malformed front matter, and case-fold
  collisions.
- Git commands use argument arrays, isolated hooks and filters, Windows
  long-path support, no force push, and external authentication. Diagnostics
  redact common credentials and tokens.
- Project writes are contained beneath the resolved project root and are staged,
  journaled, digest-checked, and atomically replaced where supported.

The “library is controlled through skill-sync” rule is a workflow policy, not a
property Git can enforce by itself. Direct pushes, web edits, or another Git
client can still change the repository. For stronger enforcement, use a private
repository, restricted credentials, branch protection, required checks, and a
ruleset that limits who may push.

## Exit statuses

| Status | Meaning                                                           |
| -----: | ----------------------------------------------------------------- |
|      0 | Complete success (warnings and skipped doctor checks are allowed) |
|      1 | Unexpected internal failure                                       |
|      2 | Invalid invocation or missing automation input                    |
|      3 | Configuration, schema, or local content validation failure        |
|      4 | Repository, authentication, or network access failure             |
|      5 | Conflict or unsafe overwrite refused                              |
|      6 | Explicit non-atomic batch completed only partially                |
|    130 | User cancellation or interrupt                                    |

## Development and release checks

```sh
npm ci
npm run check
npm run release:check
```

This repository is an Nx workspace. The publishable `skill-sync` package is the
`cli` library under `libs/cli`; builds stage its npm package at
`dist/libs/cli`. Existing npm scripts remain the stable entry points and route
project work through Nx. Individual targets can also be run directly:

```sh
npx nx show project cli
npx nx build cli
npx nx test cli
```

The CLI wiki is the Astro and React application at `apps/wiki`. Run it locally
or validate its static output through Nx-backed root scripts:

```sh
npm run wiki:dev
npm run wiki:build
npm run wiki:preview
```

The production wiki is written to `dist/apps/wiki`, separately from the staged
CLI package. When the public command surface changes, update this README, the
detailed wiki reference under `apps/wiki/src/content/docs/reference`, and the
searchable catalog at `apps/wiki/src/data/commands.ts` together.

`npm run check` runs formatting, linting, type checking, the production wiki
build, all CLI tests, and a packed CLI smoke test. `npm run release:check`
validates the staged package, and
`npm run publish:dry-run` performs a dry-run publish from `dist/libs/cli`. CI
covers Node.js 22 and 24 on Linux, macOS, and Windows and uploads the inspected
npm tarball. The unscoped `skill-sync` package name was unregistered when
checked on 2026-07-19; verify it again immediately before the first publish.
