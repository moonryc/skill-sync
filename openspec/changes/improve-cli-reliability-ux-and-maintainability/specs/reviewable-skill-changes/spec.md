## ADDED Requirements

### Requirement: Diff provides content-level review
Human `diff` output SHALL show bounded unified text patches for changed regular text files and SHALL
label the local, recorded-base, and current-canonical sides. Binary, unreadable, or over-limit files
SHALL fall back to path, type, size, and digest summaries without dumping content.

#### Scenario: Text file changed locally
- **WHEN** a tracked text file differs from its recorded base
- **THEN** diff shows a unified local-versus-base patch and identifies whether canonical content
  also changed

#### Scenario: Binary file changed
- **WHEN** a changed file is binary or exceeds the patch budget
- **THEN** diff reports a deterministic binary or large-file summary without terminal corruption

#### Scenario: Base revision is unavailable
- **WHEN** the recorded base content cannot be materialized from verified cache or Git history
- **THEN** diff reports the missing comparison side and does not imply a complete three-way review

### Requirement: Diff supports focused and bulk review
The command SHALL accept one or more selectors or `--all`, optional target filters, and mutually
exclusive patch, stat, and name-only presentation modes. Selector ambiguity SHALL be resolved before
content is read.

#### Scenario: Multiple skills are reviewed
- **WHEN** the user passes multiple qualified or unambiguous selectors
- **THEN** diff reports each skill and target in deterministic order from one shared library
  revision

#### Scenario: Name-only output is requested
- **WHEN** `--name-only` is selected
- **THEN** output contains one stable record per changed path and no file bodies

#### Scenario: Structured diff is requested
- **WHEN** `--json` is selected
- **THEN** output includes versioned per-skill, per-target, per-side change metadata and includes
  patch hunks only when explicitly requested

### Requirement: Review output remains inert and bounded
The diff engine SHALL treat all skill files as data, SHALL NOT execute external diff drivers,
text-conversion filters, hooks, pagers, or repository content, and SHALL enforce patch and total
output budgets.

#### Scenario: Skill declares an external diff driver
- **WHEN** canonical or local content contains Git attributes, executable scripts, or driver
  configuration
- **THEN** diff ignores those instructions and performs only the built-in inert comparison

#### Scenario: Patch exceeds output budget
- **WHEN** generated hunks exceed the configured terminal or JSON budget
- **THEN** output is deterministically truncated with a clear summary and a narrower follow-up
  command

### Requirement: Destructive and publish plans reference reviewed state
Dry-run and TUI plans for publish, discard-local update, uninstall, recovery restore, group removal,
and library removal SHALL identify the exact source revision and local digests being authorized.
Application SHALL revalidate those identities under the appropriate lock.

#### Scenario: Content changes after review
- **WHEN** local or canonical content changes after a preview but before application
- **THEN** application refuses or presents a changed plan for fresh confirmation instead of applying
  the stale authorization

#### Scenario: Reviewed destructive plan remains current
- **WHEN** all revision and digest identities still match at the commit boundary
- **THEN** the CLI may apply the confirmed plan and reports the backup and resulting state
