# Repository Guidelines

## Project Structure & Module Organization

This is an npm workspace managed by Nx. The CLI package is in `libs/cli/`: application use cases are under `src/application`, domain rules under `src/domain`, adapters under `src/infrastructure`, and command wiring under `src/commands`. Its tests are in `libs/cli/tests/{unit,integration,e2e}`. The documentation site is the Astro app in `apps/wiki`; authored pages and components are under `apps/wiki/src`. `openspec/changes/` contains proposals, designs, specifications, and implementation task lists for planned work.

## CLI, Skill, and Wiki Synchronization

The CLI, the Codex `skill-sync` skill, and the wiki describe the same public
command surface. Whenever a change is made to `libs/cli/`, review and update
`skills/skill-sync/SKILL.md` in the same change so the skill teaches the current
package behavior. When a CLI command, option, output contract, workflow, or
user-facing behavior changes, also update the relevant pages under
`apps/wiki/src/content/docs/` and the searchable command catalog in
`apps/wiki/src/data/commands.ts` when applicable. Keep examples, safety rules,
option names, and command links synchronized across all three surfaces.

Before completing CLI changes, search for the affected command or option in
`README.md`, `skills/skill-sync/SKILL.md`, and `apps/wiki/src/`; update stale
references and run the relevant CLI and wiki checks.

## Build, Test, and Development Commands

Run `npm install` with Node.js 22 or newer to install dependencies. Common commands:

- `npm run build` — compile and stage the CLI package in `dist/libs/cli`.
- `npm test` — run the complete CLI Vitest suite.
- `npm run test:unit`, `npm run test:integration`, `npm run test:e2e` — run one test layer.
- `npm run wiki:dev` — serve the documentation site locally; `npm run wiki:build` validates its production build.
- `npm run lint`, `npm run typecheck`, `npm run format:check` — run static checks.
- `npm run check` — run the full formatting, lint, type, wiki, test, and package smoke checks.

Use `npm run format` to apply Prettier formatting.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules, two-space indentation, single quotes, trailing commas, and a 100-column print width. Keep imports type-only where applicable; ESLint enforces this. Use `camelCase` for variables and functions, `PascalCase` for types and classes, and lowercase portable names for skill/group IDs. Prefer small, explicit domain functions and preserve the CLI’s validation and no-side-effects boundaries.

## Testing Guidelines

Tests use Vitest and are named `*.test.ts`. Put fast isolated behavior in `tests/unit`, filesystem/Git behavior in `tests/integration`, and packaged CLI workflows in `tests/e2e`. Add regression coverage for behavior changes and run the narrowest relevant suite before `npm run check`.

## Commit & Pull Request Guidelines

Recent commits are short, imperative, lowercase summaries (for example, `add global support`); follow that style and keep each commit focused. Pull requests should explain the user-visible change, identify affected packages or OpenSpec artifacts, link the relevant issue/change when available, and report validation commands run. Include screenshots for wiki or other visual changes and call out compatibility, migration, or security implications.

## Security & Configuration Tips

Never commit credentials, local config, generated `dist/` output, or caches. Treat fetched skill content as inert data; changes to authentication, Git remotes, file writes, or destructive reconciliation require tests and explicit documentation.
