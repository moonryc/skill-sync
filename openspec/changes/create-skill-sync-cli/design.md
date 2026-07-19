## Context

This repository has no application code or npm package yet. Its only real skill content is a useful example of the problem: identical OpenSpec skills are copied into both `.codex/skills` and `.claude/skills`. The new CLI must treat those copies as projections of one logical skill, work from any subsequent project after a global npm install, and keep a GitHub repository as the canonical personal library.

The library is a Git repository containing instruction files, so it is both valuable user data and a supply-chain boundary. Normal operations must work with existing Git HTTPS credentials or SSH agents, must not retain tokens, and must not execute content found in a skill. Project reconciliation also needs a durable base revision so it can distinguish a safe update from an overwrite of local work.

## Goals / Non-Goals

**Goals:**

- Ship an npm package with a `skill-sync` executable and a supported Node.js runtime contract.
- Support one default user library plus project manifests that make installations reproducible.
- Organize canonical skills into nested groups and present them by qualified ID, such as `engineering/code-review`.
- Install one logical skill into one or more agent-specific destinations without duplicating it in the library.
- Make pull, local removal, and remote publication distinct operations with previewable, recoverable behavior.
- Provide a pleasant interactive workflow and an equally complete non-interactive/JSON workflow.
- Make library changes through validated Git commits produced by the CLI.

**Non-Goals:**

- Hosting a registry, server, or GitHub App; Git remains the transport and history store.
- Executing skill scripts, hooks, installers, submodules, or arbitrary repository code.
- Synchronizing arbitrary agent settings, commands, MCP configuration, or prompts in v1.
- Merging instruction-file conflicts automatically or making `sync` bidirectional.
- Technically preventing a repository owner from editing or pushing outside this CLI. That requires GitHub permissions or branch protection; v1 treats CLI-only mutation as a workflow policy and detects incompatible/out-of-band state.

## Decisions

### 1. Build a layered TypeScript ESM CLI for Node.js 22+

The package will use TypeScript, native ESM, an npm lockfile, and a `bin` entry named `skill-sync`. Node.js 22 is the minimum so the implementation can rely on maintained runtime APIs without requiring the newest Node release. The code will separate command adapters, application services, domain models, filesystem/Git ports, and Codex/Claude target adapters. Commands will parse input and render results; reusable services will own all mutations and return structured results that can be exercised without a terminal.

A conventional command parser and prompt library may be used, but Git operations will run the installed `git` executable with argument arrays rather than shell command strings. Vitest will cover domain and integration behavior, with fixture repositories and spawned CLI tests covering real Git and filesystem transactions.

Alternative considered: a single command module with direct filesystem calls. It would be faster to scaffold but would couple prompts to mutation logic, make rollback hard to test, and impede future target adapters.

### 2. Separate user configuration, desired project state, and resolved state

User-level platform-appropriate application directories will contain:

- configuration for the default library URL, branch, preferred transport, and default targets;
- a bare or normal cache keyed by normalized remote identity;
- advisory locks, operation journals, and recoverable overwrite backups.

Credentials and credential-bearing URLs MUST NOT be stored there. Git credential helpers, SSH agents, and the authenticated `gh` executable remain responsible for authentication.

Each participating project will contain two portable JSON files:

- `skill-sync.json` records schema version, normalized library identity, desired qualified skill IDs, targets, and relative destinations;
- `skill-sync.lock.json` records the resolved library commit, content digest, installed base digest, and destination digests for each logical skill.

Both files are intended to be committed even when generated skill copies are ignored. Writes use stable ordering so diffs are deterministic. Absolute paths are never persisted.

Alternative considered: store all state globally. That makes projects non-reproducible for collaborators and makes it impossible to explain which library revision produced a checked-out skill.

### 3. Use a versioned, derived Git library layout

The canonical repository layout is:

```text
.skill-sync/library.json
skills/<group-segment>/.skill-sync-group.json
skills/<group-segment>[/<nested-group>]/<skill-name>/SKILL.md
```

`library.json` carries only the library schema version and repository settings. A `.skill-sync-group.json` marker lets Git persist an explicitly created empty group and can hold a group description; `add --group` creates missing markers. The skill catalog is still derived by scanning `skills/`, so a generated skill index cannot drift from files. A directory containing `SKILL.md` is a skill root and is not recursively treated as a group. Group and skill segments use a portable lowercase slug syntax. A skill may be root-level or grouped, and its qualified ID is its path below `skills/`.

Validation requires a regular `SKILL.md`, valid front matter, no absolute or parent-traversal paths, no escaping symlinks, no nested Git repository, and no case-insensitive qualified-path collision. Skills may live at the root or within one or more groups. Duplicate leaf names may exist in different groups, but callers must then use the qualified IDs and adapters must refuse any physical destination collision. Content identity is a deterministic SHA-256 tree digest over normalized relative paths and file bytes; timestamps and optional metadata versions do not establish freshness.

Alternative considered: maintain a checked-in catalog containing every entry and hash. It can speed listing but introduces a second source of truth and noisy merge conflicts for a personal-scale repository.

### 4. Make command direction explicit

The v1 surface is intentionally asymmetric:

| Command                           | Direction and purpose                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `init [url]`                      | Set or replace the default library, validate/cache it, or create and initialize a GitHub repository with `--create`. |
| `list`, `info`                    | Browse/filter the grouped catalog and inspect one qualified skill.                                                   |
| `install [ids...]`                | Copy selected library skills into selected project targets and begin tracking them.                                  |
| `uninstall [ids...]`              | Remove only selected managed project copies and tracking entries.                                                    |
| `status`, `diff`                  | Inspect project/library state without mutation.                                                                      |
| `sync`                            | Pull and safely reconcile every tracked skill.                                                                       |
| `update [ids...]`                 | Pull and reconcile an interactive or explicit subset; `--all` is equivalent to `sync`.                               |
| `add <path> --group <group>`      | Validate and publish a new skill to the library.                                                                     |
| `publish [ids...]`                | Publish selected edits to skills that already exist in the library.                                                  |
| `library remove <id>`             | Delete canonical library content after explicit destructive confirmation.                                            |
| `group list/create/rename/remove` | Manage group paths; nonempty destructive operations require an explicit recursive option and confirmation.           |
| `validate [id-or-path]`           | Validate a source skill, installed skill, or the entire library without executing it.                                |
| `config get/set/list`, `doctor`   | Manage non-secret defaults and diagnose runtime, Git, auth, cache, schema, and destination access.                   |

`sync` and `update` never publish. `publish` never silently chooses between divergent Codex and Claude copies; the user must first make them identical or pass an explicit `--from <target>` source after previewing the difference. Remote deletion and project uninstall use different command names to avoid destructive ambiguity.

Potential follow-ups, deliberately outside v1, are `history`/`restore` for guided Git recovery, `prune` for explicit orphan cleanup, shell `completion`, and import/export adapters for non-skill agent assets.

### 5. Delegate physical paths to target adapters

The core domain models a logical skill and a set of target projections. Built-in adapters map skills to `.codex/skills/<leaf-name>` and `.claude/skills/<leaf-name>`, detect whether their agent is present, and validate destinations remain within the project root. Installation copies canonical bytes rather than creating symlinks, because symlinks are fragile across clones and platforms.

`install` accepts explicit repeated targets and can suggest detected targets in a TTY. Non-interactive use requires explicit targets or configured defaults. Existing unmanaged destinations are collisions: installation refuses to adopt or overwrite them. If two qualified IDs share a leaf name and therefore map to the same adapter path, they cannot be installed together for that target; the CLI reports both IDs and requires the user to choose one.

Target-specific behavior is kept behind an interface so future adapters can supply their root, detection rules, validation, and projection rules without changing reconciliation.

### 6. Reconcile with a three-way content model

For every skill, reconciliation compares:

1. the installed base digest from the lock file;
2. each current managed destination digest;
3. the current library digest at one fetched commit.

This produces current, outdated, locally modified, conflicted, missing, orphaned, or unmanaged-collision states. `sync` updates all safe outdated copies and restores safe missing copies. `update` runs the same engine for selected IDs. Local modifications and conflicts are skipped by default; remote deletion leaves an orphan in place. `--discard-local` is the only option that authorizes replacing local edits, and it requires a preview, confirmation policy, and a recoverable backup.

All destinations of one logical skill are a transaction: replacements are staged, validated, moved into place, and followed by one lock update. A failure rolls that skill back. Independent skill transactions may succeed in the same batch, in which case the command reports a partial result.

Alternative considered: compare modification times or two current copies. Neither can tell whether the local copy or the library changed and both create false freshness results after a checkout.

### 7. Use optimistic, validated Git mutations

`init` accepts standard HTTP(S) URLs and SSH/scp-style URLs. A plain `http://` GitHub URL is upgraded to HTTPS before any network or authentication operation and is stored as HTTPS; the CLI never sends credentials over insecure HTTP. With `--create`, it invokes authenticated GitHub tooling, defaults to a private repository, refuses to overwrite an existing repository, initializes the schema on the selected default branch, and then records the returned clone URL. Connecting to an empty existing remote may initialize it only after confirmation; a nonempty incompatible remote is rejected.

`add`, `publish`, `library remove`, and mutating `group` commands acquire a library lock, fetch the remote, create a clean staging checkout at the fetched head, apply and validate the complete library change, create a generated commit, and push with optimistic concurrency. If the remote advances, the command refetches and retries only when the touched logical skills are unchanged; otherwise it reports divergence for the user to resolve. A failed validation, commit, or push does not update project base digests.

Clone and fetch operations disable recursive submodules and hooks under CLI control. Discovery treats every skill file as inert bytes. Logs redact URL user information and query parameters. Repository paths and all copied entries are checked with real-path containment before use.

Alternative considered: use the GitHub contents API. Git remains necessary for SSH support, offline history, atomic multi-file commits, and compatibility with GitHub Enterprise, so an API-only implementation adds rather than removes complexity.

### 8. Keep human and automation contracts equivalent

Interactive pickers display qualified IDs, groups, install state, and pending actions. Every prompt has an argument or flag equivalent. `--no-input` forbids prompts, `--yes` supplies confirmation only for actions whose destructive option was also explicitly requested, `--dry-run` previews mutations, and `--json` emits one versioned result object without decorative stdout. Secrets and copied skill contents are not printed by default.

The stable exit contract is: 0 success, 1 unexpected internal failure, 2 usage error, 3 configuration or validation failure, 4 repository/auth/network failure, 5 conflict or overwrite refusal, 6 partial multi-item failure, and 130 cancellation or interrupt. `sync --check` performs no writes and returns nonzero for drift, conflict, stale data, or access failure.

`.gitignore` management uses one idempotent marked block containing only exact normalized managed destination paths. It preserves all user-authored bytes outside that block. The manifest and lock file are not ignored.

## Risks / Trade-offs

- **[A malicious or compromised library can alter agent instructions]** → Treat content as inert, validate paths and schema, show source commit/diffs, never execute hooks or scripts, and make the Git history auditable.
- **[A pull can destroy project-local edits]** → Three-way digest checks, refusal by default, a specifically named destructive option, staged transactions, and recoverable backups.
- **[Concurrent publishers can overwrite one another]** → Fetch-before-write, per-skill base comparison, optimistic pushes, and refusal when touched content diverges.
- **[CLI-only control cannot be enforced by Git alone]** → Validate the complete library before every mutation and document optional GitHub branch protection/restricted credentials for users needing enforcement.
- **[One skill copied to multiple agent folders can diverge]** → Track every destination digest, transact them together on pull, and require an explicit source when publishing divergent projections.
- **[Two groups can contain leaf names that map to the same agent folder]** → Keep catalog identity fully qualified, detect destination collisions before mutation, and require the user to install at most one colliding skill per target until an adapter proves a portable qualified namespace.
- **[Global cache or process interruption can leave stale state]** → Use locks, operation journals, atomic rename, startup cleanup, and a non-mutating `doctor` repair recommendation.
- **[GitHub creation depends on optional tooling]** → Keep URL-based initialization fully functional with Git alone and make missing/unauthenticated GitHub tooling an actionable `doctor` result.

## Migration Plan

1. Scaffold the npm package, executable, schemas, and test harness without changing the existing `.codex` or `.claude` copies.
2. Implement read-only library validation/discovery and fixture repositories.
3. Implement project install/tracking, then reconciliation and rollback behavior.
4. Add GitHub initialization and validated library mutation flows.
5. Dogfood the CLI by creating a private test library and installing the existing OpenSpec skills into a fixture project; do not adopt or overwrite this repository's current copies automatically.
6. Publish a prerelease npm version, test global installation on supported platforms and Node versions, then publish v1 after compatibility checks.

Rollback is an npm downgrade/uninstall plus restoration from project transaction backups or Git history. Remote mutations are ordinary commits and can be reverted with a new validated CLI commit; the tool will not force-push or rewrite library history.

## Open Questions

- Is the unscoped npm package name `skill-sync` available, or should publication use a scope while retaining the `skill-sync` binary?
- Should optional GitHub branch-protection setup ship in v1 or remain documented manual hardening?
- Which additional agent target should be prioritized after the built-in Codex and Claude adapters?
