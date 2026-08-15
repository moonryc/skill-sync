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
| `--dry-run`                                | Validate and print the exact write-free setup plan.                    |
| `--expect-plan <fingerprint>`              | Apply only if the reviewed `init-v1` plan is still current.            |

An existing nonempty remote must already be a compatible `skill-sync` library. An empty remote requires confirmation before initialization. Credentials embedded in URLs are rejected.
`init` configures the user-level library connection, so `--global` and `--project` are not
applicable and are rejected. `--dry-run` and `--expect-plan` are mutually exclusive. Its help lists the supported JSON, input, confirmation, and color
options without advertising those scope selectors.

Setup is always preview-first unless the caller explicitly selects an apply path:

- `--dry-run` prints the plan and never applies it.
- `--expect-plan <fingerprint>` revalidates and applies that reviewed plan without another prompt.
- A direct `init` with none of `--dry-run`, `--expect-plan`, or `--yes` prints the plan before asking
  in an interactive human terminal. If confirmation is unavailable because of `--no-input`,
  `--json`, CI, or redirected streams, it returns the preview without making setup changes.
- Explicit `--yes` opts into planning and applying in one command when automation intentionally
  needs that behavior.

The recommended copy-paste workflow remains `--dry-run` followed by the exact `--expect-plan`
command printed in its `Next:` line.

Planning fetches the selected branch into disposable OS-temporary storage, validates the complete
library, reads the current user configuration, and prints the normalized remote, exact revision,
effects, and fingerprint. It does not write the persistent cache, saved configuration, staging
state, project state, or remote. Apply re-runs that planner under setup coordination; a changed
remote or configuration returns `INIT_PLAN_CHANGED` before applying the stale plan. The error
prints an exact re-preview command. Apply also checks the remote branch before any persistent cache
write, then promotes the already validated exact commit from disposable storage instead of
refetching an unreviewed revision.
Real `init`, `config set`, and `config unset` operations share one crash-visible user-configuration
lock across processes. If another setup/config command is active, the CLI returns
`ADVISORY_LOCK_UNAVAILABLE` with wait-and-recovery guidance; dry-run setup previews do not acquire
or create that mutation lock.

If Git cannot inspect the remote, `init` exits with `REMOTE_ACCESS_FAILED` and
status `4`. Its message includes a short, terminal-safe, credential-redacted Git
reason, asks you to verify repository and account access, and follows with
HTTPS credential or SSH key/host guidance. This probe happens before
configuration, cache, staging, or project state is changed.

For `init --create`, planning checks GitHub authentication and repository-name
availability without creating anything. Authentication, ambiguous network, and
authorization failures block creation instead of being interpreted as an
available name. If a later step fails after creation, local configuration,
cache, staging, and project state remain untouched, but the new repository may
remain on GitHub. The error calls out that boundary; inspect the repository with
the provider before retrying or deleting it.

A reachable nonempty repository must already contain a valid skill-sync
library. If it does not, `INCOMPATIBLE_LIBRARY` leaves the remote contents and
saved library configuration unchanged and directs you to an existing compatible
library, an empty repository, or `skill-sync init --create <owner/name> --dry-run`.
Disposable planning does not retain the incompatible revision in the persistent
cache and never reinitializes the nonempty remote.

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

The real operation requires confirmation. Managed project copies stay in place and become orphaned; recover canonical content through Git history if needed. A human dry-run printed without prompt capability includes `--yes` in its exact apply handoff.

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

An empty group can be removed normally. A nonempty group requires both `--recursive` and confirmation; `--yes` can answer that confirmation but cannot replace `--recursive`. A human dry-run printed without prompt capability includes every required flag in its apply handoff.
