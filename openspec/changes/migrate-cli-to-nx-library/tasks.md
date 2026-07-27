## 1. Establish the Nx workspace

- [x] 1.1 Convert the root manifest into the private `skill-sync-workspace`, declare the `libs/*` npm workspace, add Nx 23.1.0 and retain shared development dependencies and the npm package-manager declaration.
- [x] 1.2 Create `nx.json` and shared TypeScript configuration with cacheable target inputs, dependency behavior, and output definitions that include all source, manifest, documentation, and configuration inputs.
- [x] 1.3 Create the `cli` library manifest and `project.json` with project name `cli`, library type, `libs/cli/src` source root, and explicit clean, build, typecheck, lint, test-slice, full-test, and smoke-package targets.
- [x] 1.4 Regenerate `package-lock.json` and verify npm records the private root, the `skill-sync` workspace package, its runtime dependencies, and Nx development tooling correctly.

## 2. Relocate the existing CLI project

- [x] 2.1 Move `src`, `tests`, package helper scripts, the Vitest configuration, and project TypeScript configurations into `libs/cli` while preserving source-to-test relative imports.
- [x] 2.2 Move publishable package metadata and runtime dependencies into `libs/cli/package.json`, retaining the package name, version, engine, bin, files, side-effect, and publish settings.
- [x] 2.3 Update root ESLint, Prettier, TypeScript, ignore, and formatting scopes for the workspace layout without weakening existing strictness.
- [x] 2.4 Audit and update every path derived from `import.meta.url` or repository-relative traversal so library-root, workspace-root, and staged-package references resolve intentionally, including the OpenSpec dogfood test.

## 3. Implement build and package staging

- [x] 3.1 Configure TypeScript compilation to emit JavaScript, declarations, maps, and the executable shebang beneath `dist/libs/cli/dist` with the same module structure as the current package.
- [x] 3.2 Add a deterministic staging helper that assembles `dist/libs/cli` from the library manifest and root README/license, and make the Nx build output cover the complete staged directory.
- [x] 3.3 Update runtime package-version resolution and e2e CLI paths to read and execute from the staged package while preserving `bin.skill-sync = "dist/cli.js"`.
- [x] 3.4 Update the package smoke helper to pack the staged directory, validate the exact file allowlist and metadata, install it globally in isolation, and exercise the existing CLI workflows.

## 4. Preserve commands and automation

- [x] 4.1 Replace root development scripts with compatibility aliases for the corresponding `cli` Nx targets and retain the existing `check` ordering, including workspace formatting.
- [x] 4.2 Update version, dry-run, release-check, pack, and publish commands to version the library manifest and operate exclusively on `dist/libs/cli`.
- [x] 4.3 Update CI to install the workspace, run the compatibility check on Node 22 and 24 across Linux, macOS, and Windows, inspect the staged package, and upload the resulting tarball and JSON manifest.
- [x] 4.4 Update development and release documentation with the Nx project commands, preserved npm aliases, workspace layout, and staged package path.

## 5. Verify the migration

- [x] 5.1 Run `npm ci`, inspect the Nx project graph, and confirm `cli` is discovered as a library rooted at `libs/cli/src` while the root remains private.
- [x] 5.2 Run every individual Nx target and preserved root npm alias, then run `npm run check` and confirm all existing 31 test files and 161 tests pass.
- [x] 5.3 Run the release check and inspect the generated tarball to confirm only the manifest, README, license, and `dist/**` are present with unchanged package and executable metadata.
- [x] 5.4 Install the tarball globally in isolation and verify help, version, usage failures, interactive cancellation where supported, and non-interactive JSON configuration and validation from an unrelated directory.
