## ADDED Requirements

### Requirement: Release execution is gated by successful main CI
The system SHALL execute release automation only for a completed successful
`CI` workflow run whose source branch is `main`. Before creating release state,
the automation SHALL verify that the CI run's head SHA is still the current
`main` head; a stale run SHALL complete without publishing or creating release
metadata.

#### Scenario: Successful merge is the current main head
- **WHEN** CI completes successfully for the current head commit on `main`
- **THEN** the release workflow SHALL begin processing that commit

#### Scenario: CI fails for a main commit
- **WHEN** CI completes with a non-success conclusion for a commit on `main`
- **THEN** the release workflow SHALL not change package, npm, tag, or GitHub
  Release state

#### Scenario: A newer merge supersedes the completed CI run
- **WHEN** CI completes successfully but `main` has advanced beyond that run's
  head SHA before release processing begins
- **THEN** the workflow SHALL exit without releasing the stale commit

### Requirement: Each eligible merge receives a recorded patch release version
For an eligible unreleased `main` commit, the system SHALL advance the
`@moonryc/skill-sync` package by one patch SemVer version, update the lockfile,
and commit that release metadata to `main` before building the release artifact.
The version commit SHALL contain only generated release metadata changes and
shall be identifiable as an automated release commit.

#### Scenario: Eligible main commit has no pending release version
- **WHEN** release automation processes an eligible current `main` commit whose
  package version is not already published
- **THEN** it SHALL create and push one patch-version release commit before
  packaging

#### Scenario: Version commit triggers CI
- **WHEN** CI succeeds for the automated release version commit
- **THEN** release automation SHALL recognize that the version has already been
  published and exit without creating another version

### Requirement: The staged CLI package is validated and published with provenance
The system SHALL build and validate the package staged at `dist/libs/cli` before
publishing it as `@moonryc/skill-sync`. It SHALL publish through npm trusted
publishing with provenance enabled and SHALL NOT publish the private workspace
root or any other workspace.

#### Scenario: Release validation succeeds
- **WHEN** the version commit's release validation completes successfully
- **THEN** the workflow SHALL publish the staged CLI package with its release
  version and npm provenance

#### Scenario: Release validation fails
- **WHEN** build, packaging, or release validation fails
- **THEN** the workflow SHALL not publish a package or create a new GitHub
  Release for that version

### Requirement: Published packages have immutable GitHub release records
After a package version is successfully published, the system SHALL create an
annotated Git tag for that version and a GitHub Release targeting the release
commit with generated release notes. It SHALL not create a GitHub Release for a
package version that has not been successfully published.

#### Scenario: Package publication succeeds
- **WHEN** npm confirms publication of a release version
- **THEN** the workflow SHALL create the corresponding version tag and GitHub
  Release with generated notes

#### Scenario: npm publication fails
- **WHEN** npm rejects or fails publication of a release version
- **THEN** the workflow SHALL fail without creating a new GitHub Release

### Requirement: Release retries are idempotent
The system SHALL serialize release processing and SHALL treat package
publication, version tag creation, and GitHub Release creation as separately
recoverable checkpoints. A retry SHALL resume only missing checkpoints and
SHALL NOT publish an already published npm version or advance the version a
second time for the same release commit.

#### Scenario: Publication completed before a later workflow failure
- **WHEN** the package version is already present on npm but its GitHub Release
  is absent
- **THEN** a retry SHALL create the missing tag and GitHub Release without
  republishing or changing the package version

#### Scenario: Publish was interrupted before npm accepted the version
- **WHEN** an automated release commit exists but its package version is absent
  from npm
- **THEN** a retry SHALL validate and publish that existing version without
  creating another version commit
