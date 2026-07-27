## Context

`skill-sync` is an npm and Nx workspace whose only current project is the publishable `cli` library at `libs/cli`. User and contributor documentation lives in the root README, so installation guidance, concepts, command reference, safety behavior, and development instructions all compete in one long document. The wiki is an additive application: it must fit the existing npm workspace and Nx command model without becoming part of the CLI package or changing its runtime contract.

The site is documentation-first and has no server-side data, authentication, or application state. It must work as a static artifact, remain useful without client-side JavaScript for ordinary reading, and allow React only where an interactive documentation aid provides value.

## Goals / Non-Goals

**Goals:**

- Add an Nx project named `wiki` under `apps/wiki` that developers can serve, build, preview, lint, and type-check independently.
- Build the wiki with Astro, Starlight, and the official React integration.
- Organize the current CLI guidance into an approachable documentation hierarchy with navigation, search, deep links, responsive presentation, and accessible themes.
- Include one small React-powered command explorer to establish and verify the React-island path without turning the site into a client-rendered application.
- Generate a deterministic static artifact at `dist/apps/wiki` and include wiki validation in the repository's normal checks.
- Preserve the `cli` project's build, package boundary, public behavior, and staged output at `dist/libs/cli`.

**Non-Goals:**

- Selecting a hosting provider, domain, analytics service, or deployment pipeline.
- Adding authentication, collaborative editing, comments, a CMS, or server-rendered routes.
- Generating command documentation automatically from Commander definitions in this change.
- Replacing the package README; it remains the concise npm and repository entry point.
- Sharing browser bundles with, or importing runtime implementation code from, the `cli` library.

## Decisions

### Use Starlight as the Astro documentation layer

The wiki will use Astro's Starlight integration for the documentation shell and content collections. Starlight supplies accessible navigation, local static search, Markdown/MDX rendering, code highlighting, SEO metadata, and light/dark themes while preserving Astro's static-first output. The alternative is a custom Astro layout and search implementation, which would create substantial navigation and accessibility work without differentiating the CLI documentation. A React-first documentation framework was also considered, but it would ship more client JavaScript and weaken the explicit Astro requirement.

`astro.config.mjs` will configure Starlight and `@astrojs/react`. The content configuration will use Starlight's typed docs loader/schema. The site will use static output and set its output directory to the workspace-level `dist/apps/wiki` path.

### Register the wiki with explicit Nx targets

`apps/wiki/project.json` will declare an application project named `wiki`. Its `serve`, `build`, `preview`, `typecheck`, and `lint` targets will use `nx:run-commands`, mirroring the repository's existing explicit target style. Build and validation targets will declare project inputs, the static output directory, dependencies, and cache behavior; long-running serve/preview targets will not be cached.

An Astro-specific Nx plugin was considered. Explicit targets are preferred because Astro already owns its CLI lifecycle, the repository does not need generators or framework-specific project inference, and avoiding another Nx plugin reduces version-coupling. Nx still owns task discovery, dependency graph integration, caching, and output tracking.

### Make the application an npm workspace package

The root npm workspace globs will include `apps/*`, and `apps/wiki/package.json` will be private. Astro, Starlight, React, React DOM, their type packages, and Astro validation/lint integrations will belong to that workspace package, keeping application dependencies separate from the publishable CLI's runtime dependencies. The root lockfile remains the single reproducible dependency lock.

The app TypeScript configuration will extend Astro's strict configuration and enable React JSX. It will not extend the CLI's Node-oriented `tsconfig.base.json`, whose `NodeNext` settings and library set are unsuitable for browser and `.astro` sources.

### Keep content local and organize it around user journeys

Documentation will live under `apps/wiki/src/content/docs` as Markdown or MDX and be grouped into:

- an overview and quick start;
- installation and library concepts;
- guides for connecting, adding, installing, syncing, publishing, and removing skills;
- command reference grouped by library mutation, project reconciliation, inspection, and configuration;
- conflict recovery, security, automation/exit statuses, and troubleshooting;
- contributor architecture, development, testing, and release guidance.

The initial pages will adapt the current README rather than removing it. The Starlight sidebar will be explicitly ordered so core journeys remain stable as files are added. Internal links will use route-relative paths, and content will not depend on a future production hostname.

### Use React as an opt-in island

A typed `CommandExplorer` React component will let readers filter a compact command catalog by task/category and jump to the corresponding reference sections. It will be embedded in MDX and hydrated only for that component. The surrounding page, navigation, reference content, and fallback command links remain server-rendered/static, so documentation remains usable if JavaScript is unavailable.

The command catalog will be documentation-owned data, not an import from `libs/cli`, to avoid bundling Node-only CLI code into the browser. The contributor documentation will call out that command-surface changes require updating both the README/package docs and wiki reference.

### Extend validation without changing CLI entry points

Root `lint` and `typecheck` scripts will run the corresponding targets across projects. Formatting inputs will include wiki configuration, source, and content. The root `check` workflow will build the static wiki in addition to retaining CLI formatting, lint, type checking, tests, and package smoke verification, so existing CI automatically validates the application.

The existing root `build`, `test`, and packaging commands will keep their CLI meaning for compatibility. Dedicated `wiki:dev`, `wiki:build`, and `wiki:preview` scripts will expose common application workflows. Building the wiki must not write into `dist/libs/cli` or alter the staged package manifest.

## Risks / Trade-offs

- **Documentation can drift from the Commander command definitions** → Seed the catalog from the current public README, make the update obligation explicit in contributor docs, and keep automated command extraction as a possible follow-up.
- **Starlight or Astro upgrades can introduce content-schema changes** → Pin versions through the root npm lockfile and verify `astro check` plus a production build in the normal repository check.
- **React can unnecessarily increase client JavaScript** → Hydrate only the command explorer and retain static fallback links/content; ordinary wiki pages use no React runtime in the browser.
- **Adding app files to broad workspace inputs can invalidate CLI cache entries** → Keep wiki inputs project-scoped and avoid adding wiki sources to the CLI project's named inputs.
- **A root-level static output can conflict with app-local defaults** → Configure one explicit `dist/apps/wiki` output and declare the same path in the Nx build target.
- **No deployment target means users cannot yet browse a public URL** → Deliver a portable static artifact and defer provider/domain configuration to a separate change.

## Migration Plan

1. Add `apps/*` to npm workspaces and install the wiki-only dependencies in the private app package.
2. Scaffold the Astro/Starlight application, React integration, Nx project configuration, and workspace-level output path.
3. Add the documentation hierarchy, command explorer, styles, and metadata.
4. Extend root scripts, formatting/lint configuration, ignore rules, README contributor guidance, and CI-covered validation.
5. Run formatting, linting, Astro type checks, the production wiki build, and the existing CLI checks; inspect the generated static site and verify the CLI package boundary is unchanged.

Rollback consists of removing the `wiki` project and its workspace entry/dependencies, reverting shared validation configuration, and deleting `dist/apps/wiki`. No user data or CLI migration is involved.

## Open Questions

- Which provider, base URL, and custom domain will host `dist/apps/wiki`? This does not block the local application or static build and is intentionally deferred.
