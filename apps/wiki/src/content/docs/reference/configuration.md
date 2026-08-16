---
title: Configuration and global options
description: Control CLI setup, project context, output, and non-secret user defaults.
---

## Global options

Root options are placed before the command name in examples and automation for unambiguous
parsing. Their applicability comes from each leaf's registry metadata: output options are broad,
input controls appear only for commands that may prompt, and scope selectors appear only where the
command declares them. Run leaf help instead of assuming every root option applies everywhere.

| Option             | Applicability and meaning                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-V`, `--version`  | Print the installed package version; `skill-sync version` prints the same value.                                                                                                                                             |
| `--json`           | Emit exactly one versioned machine-readable JSON object for argument-driven commands and the bare quick start. The TUI does not accept it.                                                                                   |
| `--no-color`       | Disable ANSI styling; broadly supported, including by the TUI.                                                                                                                                                               |
| `--no-input`       | Disable prompts after all required choices are supplied. Accepted only by leaves that may prompt: init, install, sync, update, publish, uninstall, resume/restore/prune recovery actions, library remove, and group remove.  |
| `--yes`            | Answer an ordinary confirmation; it never substitutes for a required selector or destructive-intent option. It has the same prompt-capable applicability as `--no-input`.                                                    |
| `--project <path>` | Override project-root discovery only for commands whose leaf help declares project or managed scope.                                                                                                                         |
| `--global`         | Select user-level skill state and Codex/Claude destinations. Mutually exclusive with `--project`; supported by TUI, install, adopt, sync, update, status, diff, uninstall, list, info, validate, doctor, and recovery prune. |
| `-h`, `--help`     | Display help for the selected command. Leaf help lists only the common options that command accepts.                                                                                                                         |

JSON mode also disables prompts on prompt-capable commands. Automation must provide selectors,
source targets, overwrite intent, recursion intent, and other required choices explicitly. Add
`--no-input` only when leaf help advertises it; passing `--no-input` or `--yes` to a read-only or
otherwise non-prompting command fails with `OPTION_UNSUPPORTED` before configuration, cache,
network, project, or other command I/O.
With no subcommand, bare `--json` returns one successful quick-start envelope without reading
configuration, recovery, or project state. The `skill-sync --json version` command likewise
returns one success envelope whose data contains the installed version.

The interactive `tui` command (and a bare interactive invocation) requires a
terminal. Its help omits, and invocation rejects, `--json`, `--no-input`, and
`--yes`; it is not an automation surface.

## Command help and early validation

The typed command registry is the source for parsing and leaf help. Run
`skill-sync --help` for the categorized workflow map, then
`skill-sync <command> --help` for accepted arguments, valid choices, supported
inherited options, runnable examples, a safety note, and the relevant wiki link.

Scope selectors apply only where that leaf declares them. Invalid target, state,
visibility, transport, and configuration-key choices fail with usage status, as
do conflicting selections such as `--global` with `--project`, explicit IDs
with `--all`, `--gitignore` with `--no-gitignore`, or install `--dry-run` with
`--expect-plan`. Input controls follow the same rule: for example,
`config list --yes` and `version --no-input` fail with `OPTION_UNSUPPORTED`.
These checks happen before configuration, cache, network, or project I/O, so
correcting a typo cannot partially start the operation.

Common onboarding guesses receive semantic guidance before startup recovery or
application state is inspected. Top-level `skill-sync setup` points to
`skill-sync init <repository-url> --dry-run`, while top-level `skill-sync create` points
to `skill-sync init --create <owner/name> --dry-run`. Both remain usage errors. Other
commands and options with one safe close match still suggest the intended
spelling without executing it.

```sh
skill-sync --json --project /workspace status
skill-sync --json --global status
skill-sync --json --no-input --project /workspace install frontend/review-ui --target codex
```

Global scope is always explicit. It stores its manifest and lock in the active
skill-sync user state directory under `global/`, not in `~/.codex` or
`~/.claude`. Global target destinations are `~/.codex/skills/<name>` and
`~/.claude/skills/<name>`.

## CLI lifecycle

Use `version` to print the installed semantic version without accessing project
state or the npm registry:

```sh
skill-sync version
```

Use `self-update` to explicitly update the globally installed npm package. It
runs `npm install --global @moonryc/skill-sync@latest` without a shell and is
separate from `update`, which refreshes managed skills:

```sh
skill-sync self-update
```

The CLI checks for a newer stable release only after the interactive TUI has
opened. When one is available, the TUI shows a passive footer indicator with
the installed and available versions and this update command. Argument-driven
commands do not perform that lookup or emit an update notice.

## Shell completion

Generate static completion definitions from the same typed registry that drives
parsing and help:

```text
skill-sync completion --shell <shell>
```

`--shell` is required and accepts exactly `bash`, `zsh`, `fish`, or
`powershell`. Run `skill-sync completion --help` to see those choices, runnable
examples, applicable common options, the safety note, and this reference link.
An invalid or missing shell is a usage error before application work begins.

Without `--json`, stdout contains only the sourceable shell script plus its
final newline; no heading, progress, recovery warning, or setup message is
mixed into it. For example:

```sh
source /dev/stdin <<< "$(skill-sync completion --shell bash)"
```

With JSON, the normal versioned envelope contains the selected shell and the
same generated script body in its data:

```sh
skill-sync --json completion --shell zsh
```

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "completion",
  "data": { "shell": "zsh", "script": "..." }
}
```

Generation is deterministic for an installed CLI version and uses only static
command metadata. It does not read or write configuration, cache, project,
global, or profile state; inspect recovery evidence; contact the network; or
edit a shell startup file. Consequently, `--project`, `--global`, `--no-input`,
and `--yes` do not apply. Persistent completion files are explicit user writes
and should be regenerated after a CLI update.

See [installation](/getting-started/installation/#enable-shell-completion) for
copy-paste current-session and conservative persistent setup for every shell.

## Precedence

Resolved settings use this order, from strongest to weakest:

1. command option;
2. environment variable;
3. user configuration file;
4. built-in default.

Configuration contains no credentials and is written atomically. Platform defaults use macOS Application Support/Caches, Windows AppData, and XDG directories on Linux. Run `config path` to see the exact active file.

## Supported keys

| Key                  | Environment variable   | Values                                                       |
| -------------------- | ---------------------- | ------------------------------------------------------------ |
| `library.remote`     | `SKILL_SYNC_LIBRARY`   | HTTPS or SSH Git repository URL without embedded credentials |
| `library.branch`     | `SKILL_SYNC_BRANCH`    | Git branch name                                              |
| `library.transport`  | `SKILL_SYNC_TRANSPORT` | `https` or `ssh`                                             |
| `defaults.targets`   | `SKILL_SYNC_TARGETS`   | Comma-separated `codex` and/or `claude` targets              |
| `defaults.gitignore` | `SKILL_SYNC_GITIGNORE` | `manage` or `leave`                                          |

`SKILL_SYNC_CONFIG_HOME` overrides the isolated application config, cache, and state root. `NO_COLOR` disables color using the common environment convention.

## `config path`

Print the active user configuration path.

```text
skill-sync config path
```

Human output labels the exact `Configuration path` and suggests `config list` as the next step.
JSON mode returns the same path as structured data.

## `config list`

List supported resolved values and where each value came from.

```text
skill-sync config list
```

Human output reports `Configured values: <count> of 5`, then labels each supported `Key`, its
persisted `Configured` value, resolved `Effective` value, and `Effective source`. This makes
environment and built-in fallbacks visible without opening the file. It ends with a runnable
`config set` next step. An absent override displays as `<unset>`; an intentionally empty array
displays as `<none>` rather than a blank value. JSON mode retains the complete structured listing.

## `config get`

Read one supported key.

```text
skill-sync config get <key>
```

Example:

```sh
skill-sync config get library.remote
```

Human output labels the key, configuration path, configured value, effective value, effective
source, and a next command. An unset persisted value is shown separately from the value currently
provided by an environment variable or built-in default. When no override exists, the next action
offers `config set` only; it does not incorrectly suggest an `unset` command.

## `config set`

Validate and persist one non-secret value.

```text
skill-sync config set <key> <value>
```

Examples:

```sh
skill-sync config set defaults.targets codex,claude
skill-sync config set defaults.gitignore manage
```

The success summary repeats the configured and effective values and their source, then points to
`config get` for verification. `library.branch` and `library.transport` depend on a configured
library remote in schema v1. If either is set first, validation gives the exact prerequisite:

```sh
skill-sync config set library.remote <repository-url>
```

## `config unset`

Remove the requested persisted override and report the complete atomic change. Most independent
keys affect only themselves, but schema-v1 library fields have coupled invariants.

```text
skill-sync config unset <key>
```

Example:

```sh
skill-sync config unset defaults.gitignore
```

Human output labels the requested key, the count and names of all changed keys, the active path, and
the newly configured/effective value and source. The coupled cases are:

- Unsetting `library.remote` removes `library.remote`, optional `library.branch`, and
  `library.transport` together because a schema-v1 library record cannot exist without its remote.
  Independent `defaults.targets` and `defaults.gitignore` values are preserved.
- Unsetting an SSH `library.transport` resets transport to HTTPS and normalizes the persisted remote
  URL to HTTPS, so both `library.remote` and `library.transport` are reported as changed.
- Unsetting an independent configured key reports only that key.

An already-unset key is a truthful no-op: it does not create or rewrite the configuration file, and
human output starts with `No configuration change.` JSON distinguishes a real write from that no-op:

```json
{
  "key": "defaults.gitignore",
  "unset": true,
  "changed": true,
  "changedKeys": ["defaults.gitignore"]
}
```

```json
{ "key": "defaults.gitignore", "unset": false, "changed": false, "changedKeys": [] }
```
