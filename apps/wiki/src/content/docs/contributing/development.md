---
title: Development and release
description: Install the workspace, run focused Nx targets, validate documentation, and inspect the npm package.
---

## Prerequisites

Use Node.js 22 or 24 and the npm version declared by the root `packageManager` field. CI validates both supported Node lines on Linux, macOS, and Windows.

```sh
npm ci
```

## Common workspace commands

```sh
npm run check
npm run release:check
```

`npm run check` verifies formatting, linting, type checking, CLI tests and package smoke behavior, and a production wiki build. `release:check` repeats the repository checks and dry-runs the staged CLI package.

## Work on the CLI

Stable root scripts keep their CLI-oriented meaning:

```sh
npm run build
npm run test
npm run test:unit
npm run test:integration
npm run test:e2e
npm run smoke:pack
```

Run individual Nx targets when you need a focused operation:

```sh
npx nx show project cli
npx nx build cli
npx nx test cli
npx nx run cli:typecheck
```

The build compiles TypeScript and stages a publishable package at `dist/libs/cli`. The staged manifest exposes `dist/cli.js` as the `skill-sync` executable and includes only the package's expected runtime output, README, and license.

## Work on the wiki

```sh
npm run wiki:dev
npm run wiki:build
npm run wiki:preview
```

Documentation source lives at `apps/wiki/src/content/docs`. Astro writes the production site to `dist/apps/wiki`; it must never write into `dist/libs/cli`.

Before submitting wiki changes, run:

```sh
npx nx run wiki:lint
npx nx run wiki:typecheck
npx nx run wiki:build
```

Check navigation, search, code samples, tables, keyboard focus, both themes, and narrow viewports in the production preview.

## Keep command documentation current

Any public command, argument, option, safety rule, output contract, or exit-status change must update all relevant documentation surfaces in the same change:

1. the root/package README;
2. the detailed page under `apps/wiki/src/content/docs/reference`;
3. `apps/wiki/src/data/commands.ts` when the searchable command index changes;
4. guides or troubleshooting pages whose workflow is affected.

Compare the rendered reference against `skill-sync --help` and nested command help before marking the change complete.

## Release inspection

```sh
npm run release:check
npm run publish:dry-run
```

The package job in CI installs from the lockfile, runs release validation, inspects `dist/libs/cli`, and uploads the packed tarball. The wiki remains a separate static build artifact and is not included in the CLI package.
