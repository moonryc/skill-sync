## 1. Scope and path model

- [x] 1.1 Add explicit global-scope command parsing and reject `--global` with `--project`.
- [x] 1.2 Extend application paths with versioned global manifest, lock, and state locations.
- [x] 1.3 Define platform-aware global Codex and Claude target adapters with injectable path inputs.
- [x] 1.4 Add a scope abstraction that supplies target destinations, state paths, stable locks, and
  backup roots for project and global workflows.

## 2. Global state and installation

- [x] 2.1 Implement versioned global manifest and lock schemas with atomic read/write and migration
  validation.
- [x] 2.2 Generalize installation preflight and transaction planning to absolute global destinations
  while preserving project containment checks.
- [x] 2.3 Implement `install --global` for selected IDs, `--all`, targets, dry runs, and gitignore
  exclusion behavior.
- [x] 2.4 Add global collision, unmanaged-path, permission, and symlink safety checks.

## 3. Reconciliation and lifecycle commands

- [x] 3.1 Implement global `sync` and `update`, including offline revisions, local-edit conflicts,
  discard confirmation, backups, and lock updates.
- [x] 3.2 Implement global `status`, `diff`/inspection, and `uninstall` against global state.
- [x] 3.3 Ensure project commands continue to use project manifests and destinations unchanged.
- [x] 3.4 Add per-scope locking, journaling, recovery, and cleanup behavior for global mutations.

## 4. Diagnostics and user experience

- [x] 4.1 Update `doctor` to validate global state files, target permissions, containment, locks,
  and recoverable backups when `--global` is selected.
- [x] 4.2 Label human and JSON output with project versus global scope and absolute destinations.
- [x] 4.3 Document global commands, platform paths, state locations, collision rules, and explicit
  scope selection in the README and wiki.

## 5. Verification

- [x] 5.1 Add unit tests for platform-specific target resolution and global state path derivation.
- [x] 5.2 Add command and integration tests for global install, sync, update, status, diff, and
  uninstall flows outside a Git repository.
- [x] 5.3 Add safety tests for edited copies, unmanaged collisions, duplicate leaf names, symlinks,
  permissions, concurrent operations, dry runs, and conflicting scope flags.
- [x] 5.4 Run the full TypeScript, lint, and test suite and verify existing project workflows.
