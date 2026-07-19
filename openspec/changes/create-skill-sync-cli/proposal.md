## Why

AI skills are currently copied into agent-specific folders in each project, so the same logical skill can drift across repositories and between Codex, Claude, and future tools. A globally available CLI backed by a personal GitHub library provides one controlled source of truth and a repeatable way to discover, install, and refresh those copies.

## What Changes

- Add a globally installable npm CLI exposed as `skill-sync`, with interactive prompts for people and deterministic flags/exit codes for scripts and CI.
- Add `skill-sync init` to connect an HTTP(S) or SSH GitHub repository, upgrade insecure GitHub HTTP URLs before access, validate or initialize its library structure, and optionally create the remote repository through authenticated GitHub tooling.
- Define a canonical skill library that supports group folders while keeping one logical skill independent from its Codex, Claude, or other project destinations.
- Add `install` to browse grouped names such as `frontend/review-ui`, select skills and target agents, copy them into the project, record their source revisions, and optionally maintain exact managed entries in `.gitignore`.
- Add `sync` to refresh every tracked, outdated project skill and `update` to interactively or explicitly select which tracked project skills to refresh.
- Detect local edits, remote changes, missing files, and destination collisions before overwriting; provide previews and require explicit force or conflict resolution when data could be lost.
- Add CLI-controlled library mutation commands: `add` to publish a new local skill, `publish` to update an existing library skill, `library remove` to delete one, and `group` operations to create, rename, or remove group paths. Each successful mutation validates the library and creates a Git commit before pushing.
- Add complementary project and troubleshooting commands: `list`, `info`, `status`, `diff`, `uninstall`, `validate`, `config`, and `doctor`.

## Capabilities

### New Capabilities

- `cli-runtime`: Global npm installation, command conventions, configuration, interactive and non-interactive behavior, diagnostics, and stable exit behavior.
- `library-management`: Connection or creation of a GitHub-backed skill library, its canonical grouped layout, safe Git access, and CLI-only library mutations.
- `skill-discovery`: Group-aware catalog listing, filtering, qualified skill identities, and interactive or explicit selection.
- `project-installation`: Agent target detection, multi-target installation, tracking metadata, exact `.gitignore` management, and uninstall behavior.
- `skill-reconciliation`: Status and diff calculation plus safe all-skill `sync` and selective `update` workflows.

### Modified Capabilities

None.

## Impact

- Establishes the repository's initial Node.js/TypeScript npm package, executable entry point, tests, documentation, and release configuration.
- Adds a user-level configuration and Git cache plus project-level manifest/lock data and managed skill copies under agent-specific directories.
- Integrates with local Git credentials for HTTP(S) and SSH while refusing insecure credential transport; optional repository creation integrates with authenticated GitHub tooling without persisting credentials in skill-sync configuration.
- Mutates remote skill-library repositories, project skill directories, and optionally `.gitignore`; these paths require validation, atomic writes, and explicit destructive-action safeguards.
