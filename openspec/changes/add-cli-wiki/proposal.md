## Why

The CLI currently relies on a single repository README for both onboarding and detailed reference material, which makes the documentation harder to browse and expand as the command surface grows. A dedicated web wiki will give users and contributors a searchable, structured home for `skill-sync` documentation while remaining part of the existing Nx workspace.

## What Changes

- Add an Nx-managed Astro application with React support as the `cli` wiki.
- Provide a documentation-focused, responsive site with persistent navigation, local search, accessible light and dark themes, and Markdown/MDX-authored content.
- Seed the wiki with CLI installation, quick-start, conceptual, command-reference, safety/recovery, troubleshooting, and contributor documentation based on the current repository guidance.
- Add workspace commands and Nx targets for developing, building, previewing, linting, and type-checking the wiki independently and as part of repository validation.
- Keep the publishable `cli` library and its npm package output independent from the static wiki build.

## Capabilities

### New Capabilities

- `cli-wiki`: A browsable Astro and React documentation site for learning, operating, troubleshooting, and contributing to the `skill-sync` CLI.

### Modified Capabilities

None.

## Impact

- Adds a new `wiki` application under `apps/wiki` and a corresponding Nx project alongside `libs/cli`.
- Adds Astro, React, documentation-theme, and Nx integration dependencies plus workspace configuration and lockfile updates.
- Extends root development and validation commands, formatting/lint coverage, and repository documentation with wiki entry points.
- Produces a separate static site artifact; it does not change the CLI command surface, runtime behavior, or `dist/libs/cli` package contents.
