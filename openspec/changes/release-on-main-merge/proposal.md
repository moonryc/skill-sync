## Why

The package can be validated and packed in CI, but a successful integration to
`main` still requires someone to create a release and publish it manually. That
extra handoff makes releases slower and risks the repository, GitHub releases,
and npm registry falling out of sync.

## What Changes

- Add a release workflow that runs only after CI has completed successfully for
  the current commit on `main`.
- Generate an immutable release version, Git tag, changelog entry, and GitHub
  Release for each publishable change using repository-managed release metadata.
- Build and publish the staged `@moonryc/skill-sync` npm package with npm
  provenance enabled.
- Keep the release path safe to re-run by preventing duplicate version
  publication and ensuring validation precedes publishing.

## Capabilities

### New Capabilities

- `automated-package-release`: Generate GitHub releases and publish the CLI
  package to npm after successful CI for changes merged into `main`.

### Modified Capabilities

- None.

## Impact

- Adds GitHub Actions release automation and release metadata/configuration.
- Uses GitHub repository permissions and an npm trusted-publishing
  configuration for `@moonryc/skill-sync`.
- Changes the release process and contributor documentation; the CLI runtime
  and public commands remain unchanged.
