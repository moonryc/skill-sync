## Context

The CLI already exposes Commander’s `--version` flag by reading the published package metadata at runtime. Its existing `update` command reconciles managed skills, so using that name for package installation would be ambiguous. Command wiring is in `commands/program.ts`, while the interactive TUI has distinct initialization, action-port, and Ink-rendering layers. Command results use a structured renderer that guarantees exactly one JSON object in automation mode.

Release management therefore crosses command registration, launch orchestration, package metadata, process execution, tests, and the three synchronized documentation surfaces required by the repository guidelines.

## Goals / Non-Goals

**Goals:**

- Provide an explicit `version` subcommand with the same standard SemVer value as `--version`.
- Provide an explicit `self-update` subcommand that updates the globally installed npm package without conflating it with skill reconciliation.
- Inform interactive TUI users of a newer stable npm release when the TUI starts, without turning an advisory lookup into a command failure or interrupting their workflow.
- Preserve stable help, version, exit-code, and `--json` output contracts.
- Make registry lookup and npm process execution injectable so they can be tested without the network or a real global installation.

**Non-Goals:**

- Updating a locally linked, project-local, `npx`, or non-npm installation.
- Automatically installing upgrades, changing npm configuration, or restarting the current process.
- Checking for updates, emitting notices, or adding network latency to argument-driven CLI commands, help, or version output.
- Introducing release channels, a persistent update-check cache, telemetry, or configuration for update notices in this change.
- Changing the existing skill `update` or `sync` semantics.

## Decisions

### Use distinct `version` and `self-update` top-level commands

`version` will print only the installed package SemVer and exit successfully; `--version` remains supported with identical output. `self-update` will be the explicit package lifecycle command and will invoke npm without a shell using the published package name plus the `latest` dist-tag (equivalent to `npm install --global @moonryc/skill-sync@latest`). It will surface a structured success result after npm exits successfully and an actionable failure with a nonzero status otherwise.

Using the existing `update` command was rejected because it already means “pull selected managed skills from the library.” A bare `upgrade` name was rejected in favor of `self-update` because it states what is being updated in command listings and documentation.

### Read package identity once and use standards-aware version comparison

Package name and installed version will come from the CLI package metadata rather than being duplicated in code. A dedicated release-management service will retrieve the registry’s `latest` dist-tag and compare valid npm SemVer values with a standards-aware comparator. This avoids lexicographic mistakes such as treating `0.10.0` as older than `0.9.0`, and avoids relying on an npm executable just to perform a read-only availability check.

The registry request will target npm’s package metadata endpoint over HTTPS and use a short, abortable timeout. Its transport and clock/timeout boundary will be injected behind a small port. An npm child-process runner will also be injected behind a port and invoked with an argument array, never an interpolated shell command. These choices keep the service deterministic in unit tests and avoid command injection.

Hand-written numeric comparison was rejected because valid SemVer includes prerelease precedence rules. Running `npm view` for the launch check was rejected because it starts a process for every invocation and makes an availability check depend on the local npm executable.

### Check asynchronously only during TUI initialization and render a passive indicator

The release-management service will be available to the TUI through its action port. Once the TUI has opened, the app will start a best-effort registry check alongside its dashboard load, without blocking first render or keyboard input. When a newer stable version is found, the app will retain that result in separate UI state and render a concise low-priority footer indicator naming the installed and available versions and the `skill-sync self-update` remedy.

The indicator is informational, non-modal, and persists while the TUI is open; it must not replace operational errors, change focus, add a confirmation step, or cause the TUI to exit. Registry failures, invalid registry data, cancellation, and timeout are intentionally silent. A result is rendered only for a strictly newer version. The check is never invoked by argument-driven CLI commands, including `--json`, help, version, and offline commands.

Putting the check in `runCli` before every command was rejected because the requested scope is the TUI alone and command launch checks would add network activity and advisory output to non-interactive workflows. Rendering the result as stderr output was rejected because the TUI owns an alternate screen; a footer indicator keeps the update information visible without obscuring the current screen. A blocking check before rendering was rejected because an advisory must not delay the command center.

## Risks / Trade-offs

- [TUI startup network latency or an unavailable registry] → Start the short, abortable lookup asynchronously after initial render and continue silently on every lookup error; no TUI action depends on the result.
- [An update indicator distracts from task work] → Use a single footer line with low-priority styling; do not use a modal, focus change, or persistent operation-error state.
- [npm is missing or global installation is permission-restricted] → Treat `self-update` as a failed explicit command with its sanitized npm diagnostic and no success claim; normal commands remain unaffected.
- [The package runs from a local/link/npx installation] → Document that `self-update` targets the global npm installation and leave other installation methods unchanged.
- [A malformed or prerelease registry version] → Validate registry data and use SemVer precedence; malformed data produces no notice.

## Migration Plan

The new commands are additive and do not change existing skill reconciliation behavior. Ship the package code, tests, skill instructions, README, wiki reference pages, and command catalog together. Rollback consists of publishing a package release without the release-management command wiring; no user state, project files, or migration data are introduced.

## Open Questions

None. The initial release intentionally uses npm’s `latest` dist-tag, while opt-in channels and cached checks are deferred.
