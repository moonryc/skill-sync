## Why

`skill-sync doctor` currently presents a dense stream of raw check identifiers, which makes a
successful diagnostic hard to scan and a problem hard to act on. The new interactive inventory can
find existing valid skills, but it cannot safely bring an already-matching local copy under
skill-sync management, leaving users to manually recreate it.

## What Changes

- Present a concise, colour-capable human doctor report with an overall result, grouped check
  outcomes, plain-language labels, and an actionable remediation section while preserving the JSON
  report contract and diagnostic exit codes.
- Add an explicit adoption workflow that records a selected unmanaged project or global target
  skill as managed only when it is a validated, byte-for-byte match for an explicitly selected
  library skill and target projection.
- Extend the terminal UI inventory with selection, candidate matching, review, and confirmation for
  eligible unmanaged skills; invalid, unknown, mismatched, ambiguous, and already-managed entries
  remain non-adoptable with a clear explanation.
- Document the improved doctor presentation and the safe adoption workflow across the README,
  skill guide, and wiki command catalog.

## Capabilities

### New Capabilities

- `readable-doctor-diagnostics`: Clear, visual human-facing doctor summaries with preserved
  machine-readable output.
- `safe-unmanaged-skill-adoption`: Explicitly adopt an exact, validated unmanaged target copy into
  the selected project or global managed state.
- `interactive-unmanaged-skill-adoption`: Let TUI users review and confirm safe unmanaged-skill
  adoption from the inventory.

### Modified Capabilities

<!-- None. The repository has no baseline OpenSpec capability specs to modify. -->

## Impact

- Affects doctor rendering and its command handler, plus doctor tests.
- Adds managed-state adoption orchestration and target/inventory metadata for project and global
  scopes, with regression coverage for validation and no-overwrite guarantees.
- Extends the Ink TUI action port, screens, and tests.
- Updates the public CLI documentation in `README.md`, `skills/skill-sync/SKILL.md`, and the wiki.
