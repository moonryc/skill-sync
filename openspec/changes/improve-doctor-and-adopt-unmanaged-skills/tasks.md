## 1. Readable doctor diagnostics

- [x] 1.1 Define deterministic human doctor summary, labels, grouping, status symbols, and
  colour/no-colour rendering without changing the structured report.
- [x] 1.2 Route the doctor command's human output through the new presentation while preserving
  JSON output, redaction, scope information, offline reporting, and exit-code behavior.
- [x] 1.3 Add unit coverage for healthy, warning/failure, offline, colour-disabled, and JSON doctor
  behavior.

## 2. Safe unmanaged-skill adoption workflow

- [x] 2.1 Enrich safe inventory metadata as needed to identify eligible supported target
  projections without trusting discovered content as instructions.
- [x] 2.2 Add a shared, argument-driven adoption command and application workflow for project and
  global scopes, with explicit qualified IDs and targets.
- [x] 2.3 Verify selected local directories against canonical skill content and record normal
  manifest/lock state through existing scope-specific containment, locking, recovery, and atomic
  write mechanisms without changing target files or `.gitignore`.
- [x] 2.4 Reject invalid, unknown, managed, conflicting, unsupported, escaping, incompatible, and
  divergent inputs with precise errors and no mutation.
- [x] 2.5 Add project and global regression coverage for exact adoption, preserved existing state,
  and every no-overwrite/no-mutation rejection class.

## 3. Interactive unmanaged adoption

- [x] 3.1 Extend TUI dashboard/action types and runner adapters to expose eligibility and invoke
  the shared adoption command.
- [x] 3.2 Implement inventory selection, explicit compatible canonical skill selection, review,
  confirmation, result display, refresh, and compact keyboard navigation.
- [x] 3.3 Retain terminal-safe rendering and read-only behavior until review confirmation; clearly
  explain non-adoptable and exact-match failure states.
- [x] 3.4 Add TUI controller, app, and runner tests for success, cancellation, ineligible entries,
  ambiguous leaf names, and adoption failures.

## 4. Public-surface synchronization and validation

- [x] 4.1 Document the readable doctor output and `adopt` command in the README, skill guide, wiki
  operations/command pages, and searchable command catalog.
- [x] 4.2 Run formatting, lint, typecheck, targeted unit/integration/TUI tests, wiki build, package
  smoke test, full checks, and strict OpenSpec validation; correct all failures.
