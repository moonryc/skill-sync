---
title: Library commands
description: Exact usage for connecting, curating, grouping, publishing, and removing canonical skills.
---

These commands operate on the configured canonical Git repository. Global output and project options are described in [configuration](/reference/configuration/#global-options).

## `init`

Connect an existing compatible repository or create the default GitHub library.

```text
skill-sync init [url]
skill-sync init --create <owner/name>
```

| Option                                     | Meaning                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `--create <owner/name>`                    | Create a GitHub repository through an authenticated `gh` installation. |
| `--visibility <private\|public\|internal>` | Set create-only repository visibility; defaults to private.            |
| `--transport <https\|ssh>`                 | Set the create-only Git remote transport.                              |
| `--branch <branch>`                        | Use an explicit canonical branch.                                      |

An existing nonempty remote must already be a compatible `skill-sync` library. An empty remote requires confirmation before initialization. Credentials embedded in URLs are rejected.

## `add`

Validate and add a new local skill.

```text
skill-sync add [options] <path>
```

| Option            | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `--group <group>` | Place the new skill beneath a qualified group path.                 |
| `--dry-run`       | Report the proposed ID, files, commit, and effects without writing. |

`add` refuses an existing qualified ID. Use `publish` to update canonical content that already exists.

## `publish`

Publish edits from managed project copies to existing canonical skills.

```text
skill-sync publish [ids...]
```

| Option            | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `--all`           | Select every eligible modified managed skill.                           |
| `--from <target>` | Choose `codex` or `claude` as the source copy.                          |
| `--dry-run`       | Preview validation and canonical changes without committing or pushing. |

Provide IDs or `--all`. If target copies diverge, `--from` is required. Publishing never creates a new ID and never force-pushes.

## `library remove`

Delete one canonical skill.

```text
skill-sync library remove [options] <id>
```

| Option      | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `--dry-run` | Preview the canonical deletion without writing. |

The real operation requires confirmation. Managed project copies stay in place and become orphaned; recover canonical content through Git history if needed.

## `group list`

List explicit groups recorded in the library.

```text
skill-sync group list
```

This command reports groups with persistent markers. Catalog grouping inferred from skill paths is also visible through `skill-sync list`.

## `group create`

Create a persistent empty group.

```text
skill-sync group create <group>
```

The group path uses the same lowercase portable naming rules as qualified skill IDs.

## `group rename`

Move one group subtree.

```text
skill-sync group rename <from> <to>
```

The result reports every affected qualified skill ID. The complete proposed library is validated before the move is committed.

## `group remove`

Remove an explicit group.

```text
skill-sync group remove [options] <group>
```

| Option        | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| `--recursive` | Explicitly allow removal of a nonempty group subtree.   |
| `--dry-run`   | Preview markers, skills, and IDs that would be removed. |

An empty group can be removed normally. A nonempty group requires both `--recursive` and confirmation; `--yes` can answer that confirmation but cannot replace `--recursive`.
