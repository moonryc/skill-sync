---
title: Inspection and diagnostics
description: Browse the catalog, inspect state, compare content, validate inputs, and diagnose the environment.
---

These commands are read-only. `doctor` reports remediation but never performs it.

## `list`

List the grouped canonical catalog.

```text
skill-sync list [options]
```

| Option            | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `--group <group>` | Filter to a group subtree; repeatable.              |
| `--query <text>`  | Match identifiers or descriptions; repeatable.      |
| `--agent <agent>` | Filter by compatible agent; repeatable.             |
| `--state <state>` | Filter by project reconciliation state; repeatable. |

Repeated filters let scripts or interactive users narrow the catalog without changing it.

## `info`

Inspect one canonical skill.

```text
skill-sync info <id>
```

The result includes validated metadata, canonical revision, digest, compatibility information, and file inventory. It does not print file bodies.

## `status`

Classify every managed project copy.

```text
skill-sync status [options]
```

| Option      | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `--offline` | Inspect cached and local state without remote access. |

Possible states include current, outdated, locally modified, conflicted, missing, orphaned, and colliding. Offline results do not claim to be current with the remote.

## `diff`

Compare one managed skill with its recorded and canonical state.

```text
skill-sync diff <id>
```

Output is target-specific and identifies local and canonical digest changes. Use it before deciding whether to publish local edits or discard them during an update.

## `validate`

Validate a complete library, canonical ID, installed skill, or explicit local directory.

```text
skill-sync validate [id-or-path]
```

With no argument, the configured canonical library is validated. Validation checks schema, names, paths, file types, nesting, and case-fold safety without executing repository content.

## `doctor`

Run applicable environment and state diagnostics.

```text
skill-sync doctor [options]
```

| Option      | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `--offline` | Skip every remote or authentication check that would require network access. |

Diagnostics cover the Node runtime, Git, GitHub CLI where applicable, authentication, config, cache, library schema, project state, destination safety, locks, journals, and backups. Every check is reported as `pass`, `warning`, `fail`, or `skipped`, with remediation for non-passing results.
