---
title: Inspection and diagnostics
description: Browse the catalog, inspect state, compare content, validate inputs, and diagnose the environment.
---

These commands are read-only. `doctor` reports remediation but never performs it.

## `list`

List the grouped canonical catalog. Add `--global` to show global installation
state badges instead of project state badges.

```text
skill-sync list [options]
```

| Option            | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `--group <group>` | Filter to a group subtree; repeatable.              |
| `--query <text>`  | Match identifiers or descriptions; repeatable.      |
| `--agent <agent>` | Filter by compatible agent; repeatable.             |
| `--state <state>` | Filter by project reconciliation state; repeatable. |

Repeated filters let scripts or interactive users narrow the catalog without changing it. If the
underlying library is empty, human output tells library maintainers how to add the first skill; a
filtered miss in a populated library simply reports that no skills matched.

Human output starts with the selected project or global scope and the library identity, revision,
and freshness. It reports the total number of matches, displays the first 20, names the number
omitted, and ends with a `Next:` command for inspecting a result and running a complete install
preview, or for changing the filters. The preview chooses Codex when compatible (otherwise
Claude), supplies the project `.gitignore` policy when applicable, uses the correct global form,
and includes `--dry-run`; it can be run as printed without another missing-choice failure. When
cached data is stale, the next step instead says to rerun when remote access is available before
choosing changes. `list` does not accept `--offline`. JSON output retains every match.

## `info`

Inspect one canonical skill. `show` is the declarative read-only alias for
`info`; both forms execute the `info` command contract.

```text
skill-sync info <id>
skill-sync show <id>
```

The result includes validated metadata, canonical revision, digest, compatibility information, and
file inventory. Human output uses the same scope, library, and freshness header as `list`, reports
the complete file count, shows the first 25 inventory entries, names any omitted files, and ends
with a state-aware `Next:` command. A stale result asks for a retry when remote access is available
and does not suggest installation; an uninstalled current result uses the same complete,
preview-first command as `list`. `info` does not accept `--offline`. JSON output retains the complete
inventory. Neither form prints file bodies.

If a syntactically valid selector has no exact match, skill-sync may include at
most three deterministic closest exact IDs. Candidates must be within edit
distance 2 and meet a 60% similarity floor; they are suggestions, never an
automatic resolution. Human errors print one scope-correct exact `info` retry
for a single candidate, scope-correct exact `info` choices for ambiguity, or the
scope-correct `list` fallback when no conservative candidate exists. An
explicit project remains the safe `--project <project-path>` placeholder, and
global inspection retains `--global`. JSON keeps the structured candidate list
and attributes either invocation to `info`.

Mutation selectors use the same exact-match safety boundary but never turn a
candidate into a selection or reconstructed mutation command. Any unresolved or
ambiguous selector leaves the whole mutation selection empty and performs no
writes.

## `status`

Classify every managed project copy. Add `--global` to inspect user-level state
and absolute user-level destinations.

```text
skill-sync status [options]
```

| Option      | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `--offline` | Inspect cached and local state without remote access. |

Possible states include current, outdated, locally modified, conflicted, missing, orphaned, and colliding. Offline results do not claim to be current with the remote. If no verified cached revision exists yet, offline status performs no refresh and tells the user to rerun the same command without `--offline` when remote access is available; the online run can populate the verified cache.

Human output identifies the project root or global state directory, library revision and freshness,
total managed-skill count, and per-state counts. It displays at most 20 skills with their target
destinations and presence, names any omitted skills, and finishes with the highest-priority safe
action: refresh stale data, inspect local/conflicting work, reconcile missing or outdated copies,
or browse the catalog.

When the invocation used `--project`, human follow-up commands retain
`--project <project-path>`; replace the placeholder with the `Project` or `Scope` path printed in
the same result. This applies across catalog, install, adoption, removal, publish, status, diff,
sync, update, and healthy doctor handoffs, so a copied command cannot silently switch to the
caller's current directory.

Before the first installation, when both project state files are absent, `status` succeeds without
contacting the library. It reports that the project has no managed skills and points to `init` when
no library is configured, or to `list` and its complete preview-ready install command when one is
connected. In JSON mode this is the explicit `{ "managed": false, ... }` status-data variant;
initialized projects return the normal revision and freshness report. If exactly one state file
exists, the incomplete pair remains a validation error.

An orphaned skill cannot be reconciled because its canonical ID no longer exists. Status, diff,
and skipped reconciliation output therefore point to a scope-preserving
`skill-sync uninstall <id> --dry-run` preview, or to restoring the canonical skill in the library;
they never send the user through a diff/sync loop.

An initialized project or global scope can also reach zero managed skills after its final
uninstall. That normal revision/freshness report likewise points only to the scope-correct `list`
command and its complete preview-ready install handoff; it does not suggest an install missing its
target or project `.gitignore` policy.

Global scope behaves equivalently before its first installation. When both global state files are
absent, online and `--offline` status succeed before library or cache resolution and do not create
the state directory. Human output labels global scope and the state directory, then points to
`skill-sync list --global` when a library is configured. Without one, it names both setup routes—
`skill-sync init <repository-url> --dry-run` and `skill-sync init --create <owner/name>
--dry-run`—then says to run the printed exact apply command before directing the user to `list
--global`. JSON returns `managed: false`, `scope: "global"`, `stateDirectory`, `skills: []`,
`operation: "status"`, and the applicable `nextAction`: `skill-sync init <repository-url>
--dry-run` when unconfigured or `skill-sync list --global` when configured. If either global
state file exists, normal state-pair and configured-library validation remains mandatory.

## `diff`

Compare one managed skill with its recorded and canonical state. Add `--global`
to compare a user-level copy.

```text
skill-sync diff <id>
```

Output is target-specific and identifies local and canonical digest changes. Human output labels
scope, skill state, library revision and freshness, target count, and total difference count. It
shows at most 25 path differences per target, reports omitted differences, and ends with a
scope-correct `Next:` action. Use it before deciding whether to publish local edits or discard them
during an update. `diff` does not accept `--offline`; a stale cached result asks the user to rerun
when remote access is available. (`status` is the inspection command that supports `--offline`.)

## `validate`

Validate a complete library, canonical ID, installed skill, or explicit local directory.

```text
skill-sync validate [id-or-path]
```

With no argument, the configured canonical library is validated. Validation checks schema, names, paths, file types, nesting, and case-fold safety without executing repository content.
After a canonical ID passes, human output points to `info` for compatibility and a complete install
preview command instead of suggesting an install with missing choices. A failed explicit ID or
path points back to `validate <same-id-or-path>` rather than changing the subject to the configured
catalog. Catalog, canonical-ID, and installed-copy next actions preserve `--global` or
`--project <project-path>` when selected. JSON validation results are unchanged.

## `doctor`

Run applicable environment and state diagnostics.

```text
skill-sync doctor [options]
```

| Option      | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `--offline` | Skip every remote or authentication check that would require network access.                                   |
| `--global`  | Validate global manifest, destinations, permissions, locks, journals, and backups without resolving a project. |

Diagnostics cover the Node runtime, Git, GitHub CLI where applicable, authentication, config,
cache, library schema, project state, destination safety, locks, journals, and backups. Human output
begins with an overall healthy, attention-needed, or blocked result; identifies scope and offline
mode; reports the complete `pass`, `warning`, `fail`, and `skipped` counts; and shows at most 20
checks in failure-first order with an omitted count. Visible warning and failure remedies are
numbered. Every report ends with a relevant `Next:` action: complete the first remedy and rerun,
repeat online after skipped remote checks, or browse the selected scope when healthy. It uses
semantic colour unless `--no-color` is set. `--json` preserves the complete structured diagnostic
report and exit behavior.

Every run also performs the same read-only application recovery discovery used at startup, including
in offline, JSON, and TUI diagnostics. `Recovery state` passes when no evidence exists, warns with
counts for valid locks, incomplete journals, or backups, and fails locally for malformed or unsafe
evidence. A non-passing check points first to `skill-sync recovery list`, then to
`skill-sync recovery inspect <id>`; doctor never creates, removes, or repairs recovery state.

From the first-run TUI, **Run diagnostics** consumes that same structured report even when failed
checks make `doctor` exit nonzero. The screen shows pass, warning, fail, and skipped counts, orders
failures before warnings and skipped checks, and labels each remediation `Next:`. Long issue lists
are windowed to the terminal and show the visible range; `r` reruns the checks and Enter/Esc returns
to setup. The TUI never dumps the internal JSON result.
