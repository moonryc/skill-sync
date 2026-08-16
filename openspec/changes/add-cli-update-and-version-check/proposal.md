## Why

People running a globally installed `@moonryc/skill-sync` have no built-in way to discover or install a newer CLI release. They should be able to identify their installed version, be notified when an update is available, and deliberately update the package without confusing that operation with updating managed skills.

## What Changes

- Add a `version` command that prints the installed package's standard semantic version, matching the existing `--version` output.
- Add a `self-update` command that invokes npm to update the globally installed `@moonryc/skill-sync` package and clearly reports success or failure.
- Check the npm registry when the interactive TUI launches and display an unobtrusive in-app update indicator when a newer stable package version is available.
- Keep version checks best-effort, bounded, and silent on network or registry failures; preserve the single-object output contract for `--json` commands.
- Document the new lifecycle commands and update-notice behavior in the README, bundled Codex skill, and wiki command catalog/reference.

## Capabilities

### New Capabilities

- `cli-release-management`: Let users inspect, update, and be notified about releases of the skill-sync CLI package.

### Modified Capabilities

<!-- None. -->

## Impact

- Affected CLI command registration plus TUI initialization and rendering in `libs/cli/src/commands/` and `libs/cli/src/ui/tui/`.
- New isolated npm registry/version-comparison and npm process-execution infrastructure, with unit and packaged-CLI coverage.
- User-facing documentation in `README.md`, `skills/skill-sync/SKILL.md`, `apps/wiki/src/content/docs/`, and `apps/wiki/src/data/commands.ts`.
- The existing `update` command remains reserved for synchronizing managed skills; self-updates use a distinct command name.
