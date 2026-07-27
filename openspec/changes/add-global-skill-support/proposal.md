## Why

`skill-sync` currently manages copies only inside a selected project, which makes users repeat the
same installation and reconciliation workflow for skills they want available across all projects.
The CLI already has user-level configuration, cache, and state, so it can support a first-class
global skill scope with explicit, safe semantics.

## What Changes

- Add a global skill scope for installing, listing, inspecting, updating, syncing, and uninstalling
  skills outside any project repository.
- Add explicit command options to select global scope without changing the current project default.
- Resolve global target directories using the supported agent adapters and platform conventions,
  including Codex and Claude user-level skill locations.
- Store global-scope manifest and lock state in user-level skill-sync state rather than writing
  project manifests into the user's home directory.
- Reuse the existing reconciliation, digest, conflict, backup, dry-run, offline, and destructive
  replacement safeguards for global copies.
- Extend status, doctor, validation, documentation, and tests to distinguish project and global
  skill scopes.

## Capabilities

### New Capabilities

- `global-skill-management`: Manage canonical skills installed into user-level agent skill
  directories, including installation, synchronization, updates, inspection, status, and removal.
- `global-scope-selection`: Select and resolve global scope explicitly while preserving project
  scope as the default.

### Modified Capabilities

None. Existing project installation, reconciliation, and runtime behavior is preserved; the new
scope is specified as additive capability behavior.

## Impact

- Affects target path resolution, project-state abstractions, installation/reconciliation services,
  command parsing, status/doctor output, and user-facing documentation.
- Adds a user-level global manifest/lock/state format and migration/versioning considerations.
- Requires platform-specific tests for global Codex and Claude destinations, permissions, collisions,
  local edits, backups, and concurrent operations.
- No existing project command should change behavior unless the new global scope is explicitly
  selected.
