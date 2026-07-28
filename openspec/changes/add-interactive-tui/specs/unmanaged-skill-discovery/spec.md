## ADDED Requirements

### Requirement: The selected scope exposes a bounded unmanaged-skill inventory
The system SHALL provide the interactive workflow a read-only inventory of skill directories in the
selected project's or global scope's supported agent target roots. It MUST inspect only target-root
locations defined by supported target adapters, validate candidates using existing safe skill
directory rules, and report each discovered valid skill with its target, path, name, and management
status. The inventory MUST NOT execute any discovered file, interpret file content as instructions,
or scan arbitrary repository paths.

#### Scenario: Existing project skill is found in a supported target root
- **WHEN** a project contains a valid `.codex/skills/review-ui` directory
- **THEN** the unmanaged inventory inspects that candidate as data and displays its Codex target and
  project-relative path

#### Scenario: Invalid candidate is encountered
- **WHEN** a supported target root contains a directory that does not pass skill validation
- **THEN** the inventory reports a validation issue for that path without executing or installing it

#### Scenario: Arbitrary repository directories are not searched
- **WHEN** a repository contains a valid-looking `SKILL.md` outside supported agent target roots
- **THEN** the unmanaged inventory does not include it in its results

### Requirement: Inventory association distinguishes managed, unmanaged, and uncertain state
The system SHALL associate a discovered target/path pair with a skill only when it matches a
projection in the selected scope's valid manifest and lock state. A valid discovered skill without a
matching projection SHALL be presented as unmanaged. If the selected scope's state cannot be read
or validated, the system MUST present an inventory/state issue and MUST NOT label all discovered
skills as unmanaged on that basis.

#### Scenario: Untracked existing skill is shown as unmanaged
- **WHEN** a valid `.claude/skills/architecture` directory exists and no selected-scope projection
  records its Claude target/path pair
- **THEN** the unmanaged-skills screen lists it as unmanaged

#### Scenario: Managed projection is excluded from unmanaged results
- **WHEN** a valid target/path pair matches a selected-scope manifest and lock projection
- **THEN** the inventory associates it with that managed skill and does not list it as unmanaged

#### Scenario: Corrupt selected-scope state is not mistaken for empty state
- **WHEN** the selected scope's manifest or lock cannot be parsed or validated
- **THEN** the interface displays the state problem and does not assert that discovered skills are
  untracked

### Requirement: Viewing unmanaged skills has no adoption or destructive effect
The unmanaged-skills screen SHALL be informational. Selecting, opening, refreshing, or exiting the
screen MUST NOT add an unmanaged skill to the manifest/lock state, publish it, overwrite it,
delete it, or modify `.gitignore`. If a user later attempts an existing installation action that
would collide with an unmanaged path, the system MUST retain the established collision/preflight
protection and show its result.

#### Scenario: User reviews an unmanaged skill
- **WHEN** a user opens and then exits an unmanaged skill's details
- **THEN** its files and selected-scope state remain unchanged

#### Scenario: Installation would collide with an unmanaged skill
- **WHEN** a user selects a library skill whose destination is an unmanaged directory
- **THEN** the existing installation preflight prevents unsafe replacement and the interface shows
  the collision result
