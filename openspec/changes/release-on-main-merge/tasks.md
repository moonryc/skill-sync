## 1. Release workflow foundation

- [ ] 1.1 Add a release-state helper that identifies an automated release
  commit, reads the staged package version, and distinguishes unpublished,
  published, tagged, and released checkpoints.
- [ ] 1.2 Add root package scripts needed to bump the CLI workspace version,
  update the lockfile, validate the staged package, and publish only
  `dist/libs/cli` with provenance.
- [ ] 1.3 Add focused tests for release-state classification and retry behavior,
  including an interrupted publish and an already released version.

## 2. Post-CI release automation

- [ ] 2.1 Create a GitHub Actions release workflow triggered by completed `CI`
  runs and gate it on successful current-head `main` runs only.
- [ ] 2.2 Configure repository-level release concurrency, checkout of the
  triggering SHA, and explicit permissions for release commits/tags/releases
  and npm OIDC trusted publishing.
- [ ] 2.3 Implement the unreleased-head path: create and push the patch-version
  metadata commit, rebuild and run `npm run release:check`, then publish the
  staged CLI package.
- [ ] 2.4 Implement the recovery paths so an existing unpublished release
  commit resumes npm publication and an npm-published version completes only
  its missing tag or GitHub Release.
- [ ] 2.5 Create the annotated version tag and generated-notes GitHub Release
  only after npm reports a successful package publication.

## 3. Operational documentation and verification

- [ ] 3.1 Document the automatic patch-release policy, GitHub Actions
  write-permission requirement, and npm trusted-publisher configuration in the
  contributor release documentation.
- [ ] 3.2 Add workflow-level validation or fixtures that cover failed CI,
  non-main, stale-main, and bot version-commit no-op gates.
- [ ] 3.3 Run formatting, relevant unit tests, `npm run release:check`, and the
  repository's full check suite; inspect the workflow and staged tarball before
  enabling it on `main`.
