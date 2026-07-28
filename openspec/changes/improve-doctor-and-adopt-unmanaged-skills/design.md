## Context

The doctor command already gathers structured, redacted checks and returns stable JSON, but its
human formatter emits one ungrouped line per raw check ID. The Ink TUI already has an unmanaged
inventory, deliberately specified as read-only. Project and global installations both use a
manifest/lock pair, so any adoption must update the same durable state without copying, executing,
or replacing the discovered directory.

The change crosses diagnostic formatting, catalog inspection, durable state, project/global
mutation orchestration, the interactive action port, and public documentation. Existing safety
boundaries are retained: supported target roots only, non-symlink validated directories only,
manifest/lock pair validation, target containment, redaction, and explicit confirmation before a
mutation.

## Goals / Non-Goals

**Goals:**

- Make the human doctor result readable at a glance, with colour when the configured output mode
  allows it and useful content without ANSI colour.
- Provide an argument-driven adoption operation so the TUI delegates mutation to a testable shared
  workflow rather than writing state itself.
- Let users choose a valid inventory entry, its unambiguous qualified library ID, and a reviewable
  target projection in the TUI.
- Adopt only an exact canonical directory, atomically recording normal manifest and lock entries
  while leaving the target directory untouched.
- Support the same behaviour in selected project and global scopes.

**Non-Goals:**

- Importing, publishing, or interpreting arbitrary locally discovered skills.
- Replacing, deleting, moving, or editing an unmanaged target copy during adoption.
- Adopting a directory that is invalid, ambiguous, managed, has unreliable selected-scope state,
  or differs from its selected library skill.
- Changing the JSON doctor payload or automatic/scripted command semantics.
- Adding an unmanage/remove toggle; this change only turns an eligible unmanaged copy into a
  managed projection.

## Decisions

### Keep doctor facts separate from presentation

`runDoctor` will continue producing the existing structured report and exit-code precedence. A
human formatter will derive a deterministic summary, grouped checks, friendly check labels,
status glyphs/colour capability, and a numbered next-actions section from that report. JSON output
will continue to serialize the structured report without terminal escape sequences.

Using a formatter instead of changing the report preserves automation and makes deterministic
formatter tests possible. Simply improving existing strings was rejected because it still leaves
users with an unscannable check stream and provides no overall result or action ordering.

### Adopt by verifying canonical directory equality, never by copying

The adoption service will receive an explicit qualified library ID and target(s), resolve the
selected scope's catalog snapshot through the existing library workflow, and compare the validated
unmanaged target directory with the corresponding canonical skill directory using the same
deterministic, symlink-safe content digest model used by installation state. It will create the
normal manifest projection and lock metadata only when they match exactly.

The target directory is read as inert data and is never copied, executed, moved, or overwritten.
This prevents a local arbitrary skill from being declared equivalent to a known skill simply from
its leaf directory name. Replacing a divergent directory was rejected because it violates the
inventory's non-destructive purpose and risks erasing user content.

### Preserve normal install-state invariants and serialize mutations

Project adoption will use the existing project mutation/recovery mechanism; global adoption will
use the global equivalent. Each operation will validate the existing manifest/lock pair, reject an
existing projection or ID conflict, calculate the canonical lock fields, and durably write the
updated pair using the established atomic/recoverable path. It will run the same target containment
checks as install. No `.gitignore` changes occur because no new files are projected.

Inventing a separate adoption state file was rejected because it would make status and sync see a
different source of truth. Direct TUI writes were rejected because they would bypass shared locks,
recovery, and non-interactive validation.

### Make the inventory a constrained selector, not an implicit matcher

Inventory entries will expose enough non-sensitive metadata for the interface to determine
eligibility and associate a user choice with a precise target/path. In the TUI, only an entry with
`unmanaged` status and no validation/state issue can be selected. The user then chooses an
explicit qualified catalog skill candidate, narrowed by compatible target and leaf name where
possible. A review shows the local path, scope, target, chosen canonical ID, and the fact that the
directory will not be replaced. Confirmation invokes the shared adoption command; an exact-match
failure is shown as a recoverable result.

Automatic matching by directory name was rejected because leaf names are not unique across groups.
Offering adoption for `unknown` state was rejected because an unreadable manifest/lock pair must
not be treated as empty.

## Risks / Trade-offs

- [Large human report with many passing checks] → Group outcomes and keep successful detail compact
  while always surfacing failures, warnings, skips, and remedies.
- [Exact directory comparisons cost I/O] → Restrict comparisons to user-selected, validated direct
  target entries and one explicit catalog candidate.
- [Concurrent state changes] → Reuse existing scope-specific lock, journal, backup, and atomic
  state-write paths; revalidate state inside the mutation boundary.
- [TUI content contains terminal controls] → Continue terminal-safe rendering for discovered names,
  paths, messages, and result errors.
- [A user expects divergent local content to be accepted] → Explain in the review/result that
  adoption requires an exact match and leaves divergent local content unchanged.

## Migration Plan

1. Introduce the formatter and adoption workflow without changing existing manifests, locks, or
   JSON payloads.
2. Extend the TUI and public documentation after the shared workflow is covered by project and
   global tests.
3. If a defect is found, disable the TUI action or stop invoking the adoption command; existing
   state remains compatible because adoption writes the normal manifest/lock schema only.
