## ADDED Requirements

### Requirement: Connect a default GitHub library

The `init` command SHALL accept HTTP(S), `ssh://`, and scp-style SSH GitHub repository URLs, validate access and compatibility, and persist a credential-free normalized remote identity plus the user's chosen secure transport as the default library. A plain HTTP GitHub URL MUST be upgraded to HTTPS before network or authentication access. That default SHALL be available when `skill-sync` is run from subsequent projects, and reconnecting the same compatible remote SHALL be idempotent.

#### Scenario: Connect with HTTPS

- **WHEN** a user runs `skill-sync init https://github.com/example/skills.git` and the remote is an accessible compatible library
- **THEN** the CLI caches its current default branch, stores the credential-free normalized identity and HTTPS transport in user configuration, and reports it as the default library

#### Scenario: Upgrade a plain HTTP URL

- **WHEN** a user runs `skill-sync init http://github.com/example/skills.git`
- **THEN** the CLI normalizes the URL to HTTPS before making a network request and never sends credentials over plain HTTP

#### Scenario: Connect with scp-style SSH

- **WHEN** a user runs `skill-sync init git@github.com:example/skills.git` and Git can authenticate through the user's SSH environment
- **THEN** the CLI connects without requesting or storing an SSH key and records SSH as the transport for future Git operations

#### Scenario: Reconnect the configured library

- **WHEN** `init` is run again with an equivalent URL for the already configured compatible library
- **THEN** the CLI refreshes validation and cache state without duplicating configuration or repository content

### Requirement: Create a GitHub library repository

`init --create <owner/name>` SHALL create a new GitHub repository through authenticated GitHub tooling, default its visibility to private unless the user explicitly selects another supported visibility, initialize the library schema on its default branch, and configure the returned clone URL. It MUST refuse to replace an existing repository and MUST leave the prior default library unchanged if creation, initialization, or push fails.

#### Scenario: Create a private repository

- **WHEN** an authenticated user runs `skill-sync init --create example/skills` without a visibility option
- **THEN** the CLI creates a private repository, commits the initial library structure, pushes it, and configures it only after the push succeeds

#### Scenario: Repository name already exists

- **WHEN** `--create` resolves to an existing GitHub repository
- **THEN** the CLI refuses to overwrite or reinitialize it, reports how to connect it explicitly, and leaves local configuration unchanged

#### Scenario: GitHub tooling is unavailable

- **WHEN** `--create` is requested but the supported GitHub tooling is missing or unauthenticated
- **THEN** the CLI returns the repository-access failure, suggests the authentication or manual-creation path, and does not create partial library configuration

### Requirement: Initialize only safe existing remotes

When connecting to an existing compatible remote, `init` SHALL validate and cache it without committing. An empty remote MAY be initialized only after explicit confirmation or its non-interactive equivalent. A nonempty remote without a supported library schema MUST be refused without modifying the remote.

#### Scenario: Initialize an empty existing remote

- **WHEN** the supplied remote contains no commits and the user confirms initialization
- **THEN** the CLI creates, validates, commits, and pushes the initial schema before making the remote the default library

#### Scenario: Refuse an incompatible nonempty repository

- **WHEN** the supplied remote contains commits but lacks a supported `.skill-sync/library.json`
- **THEN** `init` reports the incompatibility and does not add, delete, commit, or push any remote content

### Requirement: Versioned canonical library layout

The library SHALL declare a supported schema version in `.skill-sync/library.json` and SHALL store skills at `skills/<skill-name>/SKILL.md` or `skills/<group...>/<skill-name>/SKILL.md`. Explicit groups SHALL be represented by `.skill-sync-group.json` markers so empty groups persist in Git. Group and skill segments MUST be portable lowercase slugs, and each qualified ID MUST be unique under portable case folding.

#### Scenario: Validate root and grouped skills

- **WHEN** a library contains `skills/format-code/SKILL.md` and `skills/frontend/review-ui/SKILL.md` with valid metadata
- **THEN** validation recognizes `format-code` and `frontend/review-ui` as distinct canonical skills

#### Scenario: Preserve an empty group

- **WHEN** `group create frontend` succeeds before the group contains a skill
- **THEN** the committed `skills/frontend/.skill-sync-group.json` marker makes the group discoverable after a fresh clone

#### Scenario: Reject a nonportable segment

- **WHEN** a group or skill path segment is uppercase, contains traversal syntax, or violates the portable slug grammar
- **THEN** library validation reports the exact invalid path and no mutating command commits it

### Requirement: Complete inert library validation

`validate` SHALL verify the schema, group markers, skill front matter, required `SKILL.md`, qualified identities, relative content inventory, and deterministic content digests. It MUST reject absolute or escaping paths, symlinks, nested Git repositories, case-folded collisions, and a skill nested beneath another skill root, MUST report all detected errors in one pass when practical, and MUST NOT execute library content or mutate any repository.

#### Scenario: Detect multiple unsafe entries

- **WHEN** validation encounters an escaping symlink and a second skill missing `SKILL.md`
- **THEN** it reports both errors, returns the content-validation status, and leaves the working tree, cache, and remote unchanged

#### Scenario: Validate one local source skill

- **WHEN** a user runs `skill-sync validate ./my-skill` on a regular local skill directory
- **THEN** the CLI applies the same portable content rules without adding the skill to the library or executing its files

### Requirement: Add a new canonical skill

`add <path> [--group <group>]` SHALL validate a local skill source, derive or accept its portable leaf name, refuse an existing qualified ID, copy its inert content into a clean checkout, create missing group markers, validate the complete resulting library, commit the addition, and push it with optimistic concurrency.

#### Scenario: Add a grouped skill

- **WHEN** a user runs `skill-sync add ./review-ui --group frontend` and `frontend/review-ui` does not exist
- **THEN** the CLI previews and commits the canonical content at `skills/frontend/review-ui`, pushes the commit, and reports its qualified ID, digest, and commit

#### Scenario: Refuse to add over an existing skill

- **WHEN** the requested qualified ID already exists in the fetched library
- **THEN** `add` performs no overwrite and directs the user to `publish` for an existing skill

### Requirement: Publish changes to an existing skill

`publish [ids...]` SHALL publish validated content only for existing library skills tracked by the current project or supplied through an explicit supported source. It MUST show or make available the local-versus-library diff, MUST refuse when the same library skill changed since the recorded base, and MUST require `--from <target>` when managed target copies diverge. After a successful push it SHALL update applicable project base state to the pushed commit and digest.

#### Scenario: Publish one locally edited skill

- **WHEN** a tracked project's copy changed, the fetched library skill still matches the recorded base, and the user confirms `skill-sync publish group/name`
- **THEN** the CLI validates the local source, commits and pushes its content, then records the pushed revision as the project's new base

#### Scenario: Refuse remote divergence

- **WHEN** both the selected local content and the same canonical library skill changed from the recorded base
- **THEN** `publish` reports a conflict, creates no commit, pushes nothing, and leaves project base state unchanged

#### Scenario: Require an explicit divergent target source

- **WHEN** the Codex and Claude copies of a selected logical skill differ
- **THEN** `publish` refuses to choose between them until the user makes them identical or explicitly selects one supported target with `--from`

### Requirement: Manage group paths through the CLI

The `group list`, `group create`, `group rename`, and `group remove` commands SHALL manage validated group markers and skill paths through Git mutations. Rename SHALL preserve every moved skill's bytes while changing its qualified ID. Removing a nonempty group MUST require both an explicit recursive option and destructive confirmation, and every group mutation SHALL report affected qualified IDs.

#### Scenario: Rename a nested group

- **WHEN** a user renames `frontend/react` to `frontend/ui`
- **THEN** the CLI previews every affected old and new qualified ID, commits the validated path moves without changing skill bytes, and reports that other projects may see the old IDs as orphaned

#### Scenario: Refuse implicit recursive removal

- **WHEN** `group remove frontend` targets a group containing skills without the recursive option
- **THEN** the command refuses the operation and leaves the library unchanged

#### Scenario: Remove an empty group

- **WHEN** a user confirms removal of a group containing only its group marker
- **THEN** the CLI commits deletion of that marker without changing skills outside the group

### Requirement: Distinguish library deletion from project uninstall

`library remove <id>` SHALL delete only the selected canonical library skill after showing its qualified ID and requiring destructive confirmation. It MUST NOT uninstall project copies, and it SHALL warn that existing installations will become orphaned while preserving recovery through Git history.

#### Scenario: Delete a canonical skill

- **WHEN** a user explicitly confirms `skill-sync library remove frontend/review-ui`
- **THEN** the CLI commits and pushes deletion of only that canonical skill and reports the commit and orphaning impact

#### Scenario: Cancel library deletion

- **WHEN** destructive confirmation is declined or unavailable without its explicit non-interactive options
- **THEN** the command performs no working-tree, commit, push, project, or configuration mutation

### Requirement: Optimistic validated Git transactions

Every library mutation SHALL acquire a cache lock, fetch the configured branch, stage changes in a clean checkout, validate the complete resulting library, create a generated nonempty commit, and push without force. If the remote advances, the CLI MAY retry from the new head only when none of the touched skills or groups changed; otherwise it MUST report divergence. Failed validation, commit, or push MUST leave the remote and project base metadata unchanged.

#### Scenario: Unrelated remote change races a publication

- **WHEN** the remote advances only in an untouched skill before a publish push
- **THEN** the CLI may restage the validated publication on the new head and push without discarding the unrelated change

#### Scenario: Touched content changes during publication

- **WHEN** the remote advances in a skill or group touched by the pending mutation
- **THEN** the CLI refuses to overwrite it, does not force-push, and reports the fetched and expected revisions

### Requirement: Git transport remains non-executable and credential-safe

Library Git operations MUST use external Git authentication, disable recursive submodule initialization, avoid repository-provided hooks and filters under CLI control, and redact credentials from diagnostics. The CLI MUST NOT run executables or lifecycle actions found in the fetched repository.

#### Scenario: Repository declares active content

- **WHEN** a library includes submodules, hooks, filters, scripts, or package lifecycle configuration
- **THEN** skill-sync treats those declarations as inert or rejects unsupported paths and does not execute or initialize them during init, discovery, or mutation
