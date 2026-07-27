## 1. Workspace and application foundation

- [x] 1.1 Extend the root npm workspace to include `apps/*`, add a private `apps/wiki/package.json` with Astro, Starlight, React, type-check, and lint dependencies, and refresh `package-lock.json`.
- [x] 1.2 Create `apps/wiki/project.json` as the Nx `wiki` application with serve, build, preview, type-check, and lint targets, including correct cache settings, inputs, dependencies, and the `dist/apps/wiki` output declaration.
- [x] 1.3 Add strict Astro/React TypeScript configuration, Astro environment declarations, and Starlight content collection configuration under `apps/wiki`.
- [x] 1.4 Configure Astro for static output, Starlight, the official React integration, and the workspace-level `dist/apps/wiki` output path.
- [x] 1.5 Add wiki-generated directories and caches to repository ignore rules without changing CLI build or cache paths.

## 2. Wiki shell and information architecture

- [x] 2.1 Configure the wiki title, description, metadata, explicitly ordered sidebar, search, and header links in the Starlight site configuration.
- [x] 2.2 Add restrained project branding and responsive custom styles that preserve Starlight's contrast, focus, theme, table, and code-block behavior.
- [x] 2.3 Build the wiki landing page with a concise CLI value proposition, installation snippet, primary quick-start path, and links into guides, reference, troubleshooting, and contributor sections.
- [x] 2.4 Create the route and content hierarchy for getting started, concepts, guides, reference, operations, troubleshooting, and contributing, and verify all sidebar entries resolve.

## 3. CLI documentation content

- [x] 3.1 Adapt the README's requirements, installation, quick start, canonical library layout, identifiers, target paths, manifest, and lockfile guidance into task-focused wiki pages.
- [x] 3.2 Document the connect/create, add, install, sync/update, publish, uninstall, library removal, and group-management workflows with safe examples and decision points.
- [x] 3.3 Create the complete command reference for every current public command and global option, including dry-run, non-interactive/JSON, overwrite, recursive, offline, and confirmation behavior.
- [x] 3.4 Document configuration precedence and keys, conflict classification, recovery and backup behavior, security boundaries, diagnostics, automation output, and exit statuses.
- [x] 3.5 Add contributor pages for the Nx layout, CLI architecture, Node support, local validation, testing, package staging, release checks, and documentation maintenance expectations.

## 4. React command explorer

- [x] 4.1 Create a typed, documentation-owned command catalog grouped by user task and reconcile its entries and links with the CLI help and README command tables.
- [x] 4.2 Implement an accessible `CommandExplorer` React component with labeled text/category filters, empty-state feedback, keyboard operation, and links to static reference sections.
- [x] 4.3 Embed the explorer as a narrowly hydrated MDX island while retaining visible static command links/content for readers without client-side JavaScript.

## 5. Workspace commands and quality integration

- [x] 5.1 Extend the flat ESLint and Prettier coverage for Astro, React, wiki configuration, components, and documentation content without weakening the CLI's strict TypeScript rules.
- [x] 5.2 Add root `wiki:dev`, `wiki:build`, and `wiki:preview` scripts; make root lint and type-check commands cover both Nx projects; and include the production wiki build in `npm run check`.
- [x] 5.3 Update the root README with the wiki's repository location, local development commands, documentation ownership guidance, and static output path while retaining its npm-package role.
- [x] 5.4 Confirm the existing CI jobs execute the extended root validation workflow and adjust path or artifact configuration only if the new wiki checks are otherwise skipped.

## 6. Verification and visual QA

- [x] 6.1 Run formatter checks, wiki linting, Astro type checking, and the Nx production build; fix all diagnostics and verify deployable files are emitted only under `dist/apps/wiki`.
- [x] 6.2 Compare the rendered command reference and explorer catalog against current CLI help, global options, README safety notes, and exit statuses; repair missing or stale entries and links.
- [x] 6.3 Preview the production build and verify navigation, search, deep links, React filtering, no-JavaScript reading, keyboard focus/order, light/dark themes, tables, and code blocks at desktop and mobile widths.
- [x] 6.4 Run the full existing repository and release validation, inspect the staged CLI package, and confirm the wiki introduces no CLI behavior or `dist/libs/cli` package-content changes.
