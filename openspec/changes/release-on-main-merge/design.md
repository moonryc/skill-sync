## Context

CI currently validates every push and pull request, and its packaging job
inspects the tarball built from `dist/libs/cli`. The only publishable workspace
is `@moonryc/skill-sync`; its manifest is in `libs/cli/package.json`, its
staged package is in `dist/libs/cli`, and it already opts into public npm
provenance. No workflow presently creates a version commit, Git tag, GitHub
Release, or npm publication.

The requested behavior is a fully automated release after a successful merge
to `main`. The release workflow must not publish untested commits, overwrite an
existing npm version, or produce a GitHub release for an unpublished package.

## Goals / Non-Goals

**Goals:**

- Release the current `main` head after its CI workflow completes successfully.
- Make every successful release a unique patch SemVer version recorded in the
  package manifest and lockfile, an immutable Git tag, a GitHub Release with
  generated notes, and an npm publication.
- Publish only the staged `dist/libs/cli` package using npm trusted publishing
  and provenance, without storing an npm automation token in the repository.
- Make retry and the bot-created version commit safe: an interrupted release
  resumes its missing work without republishing, and the resulting CI run
  settles as a no-op.

**Non-Goals:**

- Adding prerelease channels, prerelease versions, or manual version-selection
  commands.
- Publishing the private workspace root, the wiki, or GitHub Actions artifacts
  to npm.
- Changing CLI behavior, public commands, package contents, or CI coverage.
- Auto-merging arbitrary pull requests or bypassing branch-protection rules
  beyond the repository's explicitly enabled GitHub Actions release identity.

## Decisions

### Run a dedicated post-CI workflow for successful `main` commits

Add a release workflow that listens for completed `CI` workflow runs, proceeds
only when the conclusion is `success` and the triggering branch is `main`, and
checks that the triggering SHA is still the current `main` head before mutating
anything. It will use the triggering SHA rather than an unchecked workspace
checkout. This keeps the publication directly gated by the same CI that tested
the merge and avoids releasing stale commits when multiple merges land close
together.

Adding the publish steps to the existing CI workflow was rejected because it
would couple privileged mutation to pull-request runs and make it harder to
express the required successful-main-only gate. A plain `push` workflow was
rejected because it cannot directly assert that the corresponding CI run
succeeded.

### Create a patch-version release commit before building the package

For an unreleased current `main` commit, the workflow advances
`@moonryc/skill-sync` by one patch version, updates the workspace lockfile, and
commits only those release metadata changes with a recognizable release commit
message. It pushes that commit to `main`, then rebuilds and validates the
staged package from the release commit before publication. The Git tag and
GitHub Release target that release commit, so the source of the published
version is recoverable from Git.

A patch bump is the deterministic default because the requested policy releases
each successful merge and no existing change-fragment or conventional-commit
policy supplies a semantic bump type. Changesets and conventional-commit-based
release automation were rejected: both would add per-PR authoring conventions
and can defer or suppress a release after a successful merge.

### Publish first, then create the public GitHub release

After the release commit is built and `npm run release:check` passes, the
workflow publishes only `dist/libs/cli` with npm provenance through GitHub
Actions OIDC. It then creates an annotated version tag and GitHub Release with
automatically generated release notes. The release job receives `contents:
write` for the version commit/tag/release and `id-token: write` for npm trusted
publishing; it does not require a long-lived npm token.

Creating a GitHub Release before npm publication was rejected because a failed
publish would expose a release that users cannot install. Publishing the
workspace root was rejected because it is private and not the CLI's staged
package contract.

### Make release state idempotent and recoverable

The workflow treats the package version, its Git tag, and its GitHub Release as
independent checkpoints. If the current head is a release commit whose package
version is not on npm, a retry validates and publishes that existing version
without another bump. If npm already contains the version but the tag or GitHub
Release is missing, it creates only the missing GitHub state. If all checkpoints
exist, including the CI run triggered by the bot's version commit, it exits
successfully without changes.

The workflow will use a repository-level concurrency group so that only one
release can calculate or create a version at a time. Blindly rerunning the full
version-and-publish sequence was rejected because npm versions are immutable
and could leave extra version commits after a partial failure.

## Risks / Trade-offs

- **[The GitHub Actions identity cannot push the version commit to protected
  `main`.]** → Configure repository branch protection to permit this narrowly
  scoped workflow identity, or use an approved release-specific credential;
  document the prerequisite before enabling the workflow.
- **[npm trusted-publishing is not configured for the scoped package.]** →
  Register this repository and release workflow as the npm package's trusted
  publisher before merging the workflow; OIDC publication then fails closed.
- **[A second merge arrives while release CI is finishing.]** → Recheck the
  triggering SHA against `main` under the concurrency lock; skip the stale run
  and let CI for the newer head trigger the release.
- **[Publication succeeds but GitHub Release creation fails.]** → The next
  successful workflow run detects the published version and completes the tag
  and release without a duplicate npm publish.
- **[Every merge, including documentation-only changes, consumes a patch
  version.]** → This deliberately follows the requested merge-driven policy;
  release granularity can be changed later by adopting explicit release
  metadata.

## Migration Plan

1. Add the release workflow, release helper/script support, and tests that
   verify its gating, staged-package target, idempotence, and permissions.
2. Document the GitHub Actions write-permission and npm trusted-publisher setup
   required before the workflow is enabled on `main`.
3. Merge the automation after the npm package configuration is in place; the
   next CI-successful `main` merge creates the first automated patch release.
4. Verify the first release's Git commit, tag, GitHub Release, npm provenance,
   and installability.

Rollback is a workflow disable or revert. Published npm versions and GitHub
releases remain immutable; any incorrect release is superseded by a later patch
release rather than republished.

## Open Questions

None. The initial policy intentionally uses an automatic patch bump for every
successful `main` merge; a changeset-based semantic version policy can be
proposed separately if release cadence changes.
