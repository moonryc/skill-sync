## 1. Release-management foundation

- [x] 1.1 Add package metadata access and standards-aware SemVer comparison support, including any direct dependency and lockfile updates required for valid npm version precedence.
- [x] 1.2 Define injectable release-management ports for npm registry lookup and shell-free npm process execution, then implement their Node adapters with HTTPS, abortable timeout, and sanitized diagnostics.
- [x] 1.3 Implement the release-management service that validates the `latest` dist-tag, determines whether an update is available, and runs `npm install --global <published-package>@latest` only for an explicit self-update request.
- [x] 1.4 Add focused unit coverage for SemVer precedence, valid/invalid registry responses, timeout/failure behavior, npm argument construction, successful updates, and sanitized update failures.

## 2. CLI command and launch integration

- [x] 2.1 Register a `version` top-level command that prints the same installed SemVer as `--version` without recovery inspection, project/config discovery, registry access, or command execution.
- [x] 2.2 Register `self-update`, route it through the default command executor and release-management service, and retain the existing managed-skill `update` command unchanged.
- [x] 2.3 Extend the TUI action port and initialization flow to start an injectable best-effort update check only after the interactive TUI renders, without delaying dashboard load or input handling.
- [x] 2.4 Render a passive low-priority TUI footer indicator only for a strictly newer release; keep it separate from action results and errors, and preserve command-launch behavior with no registry lookup or advisory output.
- [x] 2.5 Extend program, dispatch, TUI, and packaged CLI tests for the new command surface, stable version output, TUI-only update-check eligibility, indicator rendering, and all update-check failure/non-notice paths.

## 3. Documentation and verification

- [x] 3.1 Update `README.md` and `skills/skill-sync/SKILL.md` with `version`, `self-update`, the distinction from skill `update`, installation constraints, and TUI-only update-indicator behavior.
- [x] 3.2 Update the wiki configuration/reference documentation and searchable `apps/wiki/src/data/commands.ts` catalog for the new lifecycle commands and TUI update indicator.
- [x] 3.3 Search the README, bundled skill, and wiki for affected version/update references; run formatting, targeted CLI tests, type/lint checks, the wiki build, and the relevant package smoke validation.
