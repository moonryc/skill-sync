## Context

Today project workflows resolve a repository root and write managed copies plus
`skill-sync.json`/`skill-sync.lock.json` there. User-level application paths already exist for the
library cache, configuration, backups, journals, and locks, but agent target adapters only expose
project-relative destinations. Global management needs an explicit scope, platform-aware target
resolution, and persistent state that is independent of any repository.

## Goals / Non-Goals

**Goals:**

- Add an explicit global scope to project-like commands without changing the default.
- Resolve Codex and Claude user-level skill directories on macOS, Linux, and Windows using injectable
  platform/path dependencies for deterministic tests.
- Reuse canonical library resolution, digest comparison, atomic writes, backups, conflict handling,
  offline revisions, and confirmation rules.
- Keep global state separate from project manifests and make status/doctor identify its scope.

**Non-Goals:**

- Supporting arbitrary agent-specific global directories through user configuration in this change.
- Automatically migrating existing project installs to global scope.
- Installing skills into the CLI package, the canonical library checkout, or every project at once.

## Decisions

- **Explicit `--global` scope:** Add a mutually exclusive global selector to install, sync, update,
  status, diff/info where applicable, and uninstall. Without it, commands retain project behavior.
  A named scope is safer than inferring global intent from the current directory. `--project` and
  `--global` together fail as a usage error.
- **User-level target adapters:** Extend target definitions with a global destination resolver. The
  resolver returns absolute paths only after validating the platform and target; project resolvers
  remain relative and contained by the project root. This avoids treating home directories as fake
  projects.
- **Separate global state:** Store a versioned global manifest and lock file in the existing
  skill-sync state/config area, with paths exposed by `ApplicationPaths`. Do not place metadata in
  `~/.codex` or `~/.claude`, where it could conflict with the agents.
- **Shared reconciliation engine:** Generalize the project-root input into a managed-scope storage
  abstraction containing absolute destinations, state paths, and a stable scope key. Reuse the
  existing three-way digest and transaction machinery while retaining per-scope locks/backups.
- **Target semantics:** Global Codex and Claude installs use each tool's user-level skill directory
  and the existing leaf-name collision rules. A global install of two qualified IDs with the same
  leaf name into one target is rejected before writes.
- **Safe destructive behavior:** Global local edits require the same explicit discard flag and
  confirmation as project edits. Uninstall and replacement create recoverable backups through the
  existing user-state backup facility.

## Risks / Trade-offs

- [Path conventions change across agent versions/platforms] → Centralize adapters, document the
  supported paths, and test each platform through injected OS/path fixtures.
- [Global state becomes difficult to discover or repair] → Add `config path`/doctor reporting for
  global manifest, lock, backup, and destination paths.
- [A global skill can collide with an unmanaged user skill] → Preflight every destination and stop
  before mutation unless the existing path is owned by the matching global lock state.
- [Refactoring project and global workflows can regress project behavior] → Preserve project adapter
  tests and add contract tests that run the same reconciliation cases against both scope types.

## Migration Plan

1. Add versioned global state paths and adapters without changing project resolution.
2. Implement explicit global command handling and shared scope-aware reconciliation.
3. Add documentation, doctor/status visibility, and cross-platform tests.
4. Release as additive behavior; no existing files are migrated or rewritten automatically.

Rollback is a package downgrade. Existing project manifests remain compatible, and global files can
be left in place for a later version because the new state is isolated and versioned.

## Open Questions

- Confirm the exact user-level directories for the supported Codex and Claude runtimes and whether
  either runtime offers an environment-variable override that should take precedence.
- Decide whether global status should be the default when invoked outside a Git repository, or
  whether it should always require `--global` (this design favors always requiring the flag).
