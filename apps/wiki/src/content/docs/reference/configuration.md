---
title: Configuration and global options
description: Control project context and output, and manage non-secret user defaults.
---

## Global options

Global options apply to every command. Place them before the command name in examples and automation for unambiguous parsing.

| Option             | Meaning                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `-V`, `--version`  | Print the installed package version.                                                  |
| `--json`           | Emit exactly one versioned machine-readable JSON object.                              |
| `--no-color`       | Disable ANSI styling.                                                                 |
| `--no-input`       | Disable interactive prompts; missing required choices fail instead.                   |
| `--yes`            | Answer ordinary confirmations only after any required destructive option is explicit. |
| `--project <path>` | Override project-root discovery.                                                      |
| `-h`, `--help`     | Display help for the selected command.                                                |

JSON mode also disables prompts. Automation must provide selectors, source targets, overwrite intent, recursion intent, and other required choices explicitly.

```sh
skill-sync --json --no-input --project /workspace status
```

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

## `config list`

List supported resolved values and where each value came from.

```text
skill-sync config list
```

## `config get`

Read one supported key.

```text
skill-sync config get <key>
```

Example:

```sh
skill-sync config get library.remote
```

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

## `config unset`

Remove one persisted user override so resolution falls back to the environment or built-in default.

```text
skill-sync config unset <key>
```

Example:

```sh
skill-sync config unset defaults.gitignore
```
