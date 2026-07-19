## ADDED Requirements

### Requirement: Discover canonical skills without executing them

Catalog operations SHALL recursively discover logical skills from the validated canonical `skills/` tree of the configured library. A skill SHALL be cataloged once from the directory containing its required `SKILL.md`, and discovery MUST stop scanning for nested skills beneath that skill root. Discovery MUST treat all skill files as inert data and MUST NOT execute scripts, hooks, binaries, Git submodules, or package lifecycle actions found in the library.

#### Scenario: Discover skills in nested groups

- **WHEN** the canonical tree contains `skills/frontend/review-ui/SKILL.md` and `skills/frontend/react/create-component/SKILL.md`
- **THEN** discovery returns exactly one logical record for `frontend/review-ui` and one for `frontend/react/create-component`, including each skill's validated metadata

#### Scenario: Inspect a skill that contains executable files

- **WHEN** a discovered skill directory also contains scripts or package metadata with lifecycle actions
- **THEN** discovery may list those files as inert skill content but does not execute or install any of them

#### Scenario: Treat nested SKILL files as content

- **WHEN** a discovered skill directory contains an example or fixture subdirectory with another file named `SKILL.md`
- **THEN** discovery keeps that file within the outer skill's content tree and does not create a second catalog record from it

### Requirement: Group-qualified skill identity

Each skill SHALL have a stable qualified identifier formed by joining its zero or more group path segments and skill directory name with forward slashes, independent of the host operating system. Root-level skills SHALL use the skill name alone, grouped skills SHALL be displayed with the group prefix such as `frontend/review-ui`, and agent-specific destinations or installed copies MUST NOT create additional catalog identities for the same logical skill.

#### Scenario: Identify root and grouped skills

- **WHEN** the library contains `skills/format-code/SKILL.md` and `skills/frontend/review-ui/SKILL.md`
- **THEN** their catalog identifiers are `format-code` and `frontend/review-ui` respectively on every supported operating system

#### Scenario: Present one logical skill for several agent targets

- **WHEN** `frontend/review-ui` declares support for both Codex and Claude destinations
- **THEN** catalog results contain one `frontend/review-ui` record with its compatibility data rather than separate Codex and Claude records

### Requirement: Unambiguous selector resolution

Commands that accept skill selectors SHALL resolve an exact qualified identifier first. An unqualified leaf name SHALL resolve only when exactly one catalog skill has that leaf name; an unknown selector or an ambiguous leaf name SHALL fail selection before any mutation and SHALL report the qualified identifiers that are valid candidates when such candidates exist.

#### Scenario: Resolve a unique leaf name

- **WHEN** `frontend/review-ui` is the only catalog entry whose leaf name is `review-ui` and a user selects `review-ui`
- **THEN** the selector resolves to `frontend/review-ui`

#### Scenario: Reject an ambiguous leaf name

- **WHEN** both `frontend/review-ui` and `backend/review-ui` exist and a user selects `review-ui`
- **THEN** selection fails before mutation and the diagnostic lists both qualified identifiers so the user can choose explicitly

#### Scenario: Reject an unknown selector

- **WHEN** a user explicitly selects an identifier that is not in the current candidate catalog
- **THEN** selection fails before mutation and identifies the missing selector without silently choosing a similarly named skill

### Requirement: Group-aware catalog listing

The `list` command SHALL print one entry per available logical skill using the qualified identifier, SHALL preserve group hierarchy in human-readable output, and SHALL sort results deterministically by qualified identifier. JSON output SHALL include at least `id`, `name`, `group`, validated descriptive metadata, compatible agents, and project installation state for each result.

#### Scenario: List a mixed catalog

- **WHEN** the catalog contains root skills and skills in nested groups and a user runs `skill-sync list`
- **THEN** every skill is shown once under its qualified identifier in deterministic identifier order and nested group membership remains visible

#### Scenario: List the catalog as JSON

- **WHEN** a user runs `skill-sync list --json`
- **THEN** the command returns deterministic skill records containing the required identity, metadata, compatibility, and installation fields without terminal-only formatting

#### Scenario: List an empty valid catalog

- **WHEN** the configured library is valid but contains no skills
- **THEN** `list` reports an empty catalog, exits successfully, and does not treat the absence of skills as a validation failure

### Requirement: Read-only skill detail inspection

The `info <id>` command SHALL resolve identifiers with the same qualified-selector rules as other catalog commands and SHALL report the selected skill's qualified identity, validated descriptive metadata, compatible agents, source revision and digest, relative content inventory, and current project installation state without printing file contents or mutating project, cache, or library state.

#### Scenario: Inspect a grouped skill

- **WHEN** a user runs `skill-sync info frontend/review-ui`
- **THEN** the command reports the canonical `frontend/review-ui` record and its source and project state without copying, executing, or changing the skill

#### Scenario: Refuse ambiguous detail lookup

- **WHEN** a user runs `skill-sync info review-ui` and that leaf name exists in more than one group
- **THEN** the command reports each matching qualified identifier, returns a validation failure, and does not choose one implicitly

### Requirement: Composable catalog filters

The `list` command and interactive selectors SHALL support repeatable `--group <path>` filters for exact group subtrees, `--query <text>` filters for case-insensitive text across qualified identifier and description, `--agent <agent>` compatibility filters, and `--state <state>` project-installation filters. Different filter kinds SHALL be combined with logical AND, repeated values of the same filter kind SHALL be combined with logical OR, and filtering MUST NOT change skill identifiers or ordering.

#### Scenario: Filter a group subtree

- **WHEN** a user filters for group `frontend` and the catalog contains skills in `frontend`, `frontend/react`, and `backend`
- **THEN** results include the `frontend` and `frontend/react` skills and exclude the `backend` skills

#### Scenario: Compose filters

- **WHEN** a user filters for group `frontend`, agent `claude`, and query text `review`
- **THEN** the result contains only deterministically ordered skills under the `frontend` subtree that support Claude and whose identifier or description contains `review` case-insensitively

#### Scenario: Filter with no matches

- **WHEN** `skill-sync list` receives valid filters that match no skill
- **THEN** it returns an empty result and exits successfully rather than falling back to the unfiltered catalog

### Requirement: Interactive multi-selection

When a skill-consuming command is run interactively without explicit selectors, it SHALL present a multi-select picker over that command's eligible candidate set. Every option SHALL show the qualified identifier and enough metadata to distinguish it, group prefixes SHALL remain visible during search, and the command SHALL show the resolved selection before asking for any confirmation required by the consuming capability.

#### Scenario: Select skills from different groups for installation

- **WHEN** `install` is run in an interactive terminal without selectors and the user chooses `frontend/review-ui` and `backend/review-api`
- **THEN** the picker preserves both qualified identifiers and returns exactly those two logical skills to the installation workflow

#### Scenario: Select from the update candidate set

- **WHEN** `update` is run interactively without selectors and the project tracks only two of five library skills
- **THEN** the picker offers only the tracked skills eligible for update and does not offer the other library skills

#### Scenario: Submit an empty interactive selection

- **WHEN** a user confirms an interactive picker without selecting any skill
- **THEN** the CLI reports that no skills were selected, exits successfully without performing a mutation, and does not reinterpret the empty selection as all skills

### Requirement: Explicit deterministic selection

Every skill-consuming command SHALL accept explicit qualified identifiers through its documented positional `<id>` or `[ids...]` arguments, and batch commands SHALL accept `--all` when applying to their entire eligible candidate set is supported. Explicit selectors MUST be resolved and validated as a complete set before the consuming operation begins, duplicate selectors SHALL collapse to one logical skill, and `--all` MUST NOT be inferred merely because input is non-interactive.

#### Scenario: Select several skills non-interactively

- **WHEN** an automation run supplies two valid qualified selectors with `--no-input`
- **THEN** the command resolves exactly those two skills in deterministic identifier order without prompting

#### Scenario: Reject a partially invalid explicit set

- **WHEN** an explicit selection contains two valid identifiers and one unknown identifier
- **THEN** the complete selection is rejected before any of the valid skills are mutated and the diagnostic identifies the unknown identifier

#### Scenario: Deduplicate repeated selectors

- **WHEN** the same qualified identifier is supplied more than once
- **THEN** the consuming workflow receives that logical skill exactly once

#### Scenario: Require explicit all-selection in automation

- **WHEN** a skill-consuming command runs non-interactively without selectors and without `--all`
- **THEN** it fails with the standard missing-input status and does not select or mutate any skill

### Requirement: Invalid catalogs are not partially selectable

Discovery SHALL validate catalog identities and required skill metadata before returning selectable records. If the library contains malformed skill entries, unsafe paths, duplicate qualified identifiers, or identifiers that collide under the supported portable case-folding rules, discovery MUST report all detected catalog errors and MUST NOT expose a partial catalog to an install, update, publish, or other mutating workflow.

#### Scenario: Reject a case-colliding catalog

- **WHEN** a library contains skills whose qualified identifiers differ only by portable case folding
- **THEN** discovery reports both conflicting paths, returns a validation failure, and provides no candidates to the consuming mutation

#### Scenario: Reject one invalid entry among valid entries

- **WHEN** a catalog contains valid skills and one skill with missing required metadata or an unsafe path
- **THEN** discovery reports the invalid entry, does not silently offer only the valid subset to a mutating command, and leaves project and library state unchanged
