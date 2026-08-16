# Implementation Notes

## Baseline inventory

Captured on 2026-07-30 before implementation of this change. The working tree already contains the
`add-cli-update-and-version-check` implementation and work associated with
`release-on-main-merge`; those files are treated as coordinated inputs, not as disposable baseline
changes.

### Command and option surface

`libs/cli/src/commands/program.ts` currently owns Commander registration and declares:

- root options: `--json`, `--no-color`, `--no-input`, `--yes`, `--project <path>`, and `--global`;
- top-level commands: `version`, `self-update`, `init`, `tui`, `install`, `adopt`, `sync`, `update`,
  `add`, `publish`, `list`, `info`, `diff`, `status`, `uninstall`, `validate`, `config`, `doctor`,
  `library`, and `group`;
- config commands: `path`, `list`, `get`, `set`, and `unset`;
- library commands: `remove`;
- group commands: `list`, `create`, `rename`, and `remove`.

Registration, dispatch names, and option consumption are duplicated across
`commands/program.ts`, `commands/default-executor.ts`, `commands/workflow-handler.ts`,
`commands/config-doctor-handler.ts`, the README, the bundled skill, and the wiki command catalog.
`commands/program.ts` merges inherited and local options into a string-keyed record, so unsupported
inherited options can reach handlers.

### Output and UI surface

- `ui/output.ts` owns the current schema-version-1 JSON envelope and generic human serialization.
- `domain/result.ts` owns result/error sanitization and exit classes.
- `commands/program.ts` writes `version` directly, bypassing the common JSON renderer.
- `ui/prompt.ts` owns non-TUI confirmation.
- `ui/tui/{app,controller,runner,sanitize,types}.ts` owns the interactive workflow.
- There is no shared progress-event contract or shell-completion command.

Existing output coverage is concentrated in `result-output.test.ts`, `program.test.ts`,
`program-dispatch.test.ts`, `default-executor-dispatch.test.ts`, `prompt.test.ts`, and the
`tui-*.test.ts` files.

### Durable state and mutation surface

- User configuration schema v1 and application paths live in `infrastructure/config.ts`.
- Project manifest/lock schemas v1 live in `domain/project-state.ts` and
  `infrastructure/project-state.ts`.
- Global state reuses the project schema versions through `infrastructure/global-state.ts`.
- Library schema v1 lives in `domain/library.ts`.
- Cache state schema v1 and exact-revision snapshots live in `infrastructure/library-cache.ts`.
- Advisory locks, journals, staging, backups, and atomic replacement live in
  `infrastructure/transactions.ts`.
- Journal schema v1 records destination/action/state but not deterministic candidate and rollback
  paths or a transaction-root fingerprint.
- `application/recovery.ts` scans only the top-level application lock, journal, and backup
  directories.
- Project mutation orchestration is split across `application/project-installation.ts`,
  `application/project-reconciliation.ts`, and `application/project-storage.ts`.
- Global mutation orchestration is concentrated in `application/global-skill-management.ts`.
- `application/managed-scope.ts` describes scopes but is not yet the shared state/mutation adapter.

Existing durable-state coverage is concentrated in `durable-config.test.ts`,
`durable-project-state.test.ts`, `durable-transactions.test.ts`, `recovery.test.ts`,
`project-installation-service.test.ts`, `project-reconciliation-service.test.ts`,
`global-skill-management.test.ts`, and `project-storage.test.ts`.

### Cache, locks, and subprocess surface

- Project/global destination mutations use filesystem advisory locks from
  `infrastructure/transactions.ts`.
- Cache refresh and canonical library lifecycle correctness still default to the process-local
  lock in `infrastructure/library-cache.ts`.
- Git execution has a local process-runner abstraction in `infrastructure/git.ts`.
- Direct `execFile` call sites remain in `application/doctor.ts`,
  `application/library-lifecycle.ts`, `infrastructure/git.ts`, and the in-progress
  `infrastructure/npm-updater.ts`.
- Cancellation is exposed at the runtime boundary but is not consistently passed through all
  cache, hashing, staging, transaction, and subprocess operations.
- Full-tree integrity hashing in `infrastructure/library-cache.ts` reads regular-file bodies into
  memory and has no shared file-count, byte, depth, or concurrency budget.

Existing boundary coverage is concentrated in `git-infrastructure.test.ts`,
`library-cache.test.ts`, `runtime-boundary.test.ts`, `library-lifecycle.test.ts`,
`doctor.test.ts`, and the transaction/service tests listed above.

### Packaged and documentation surface

- `libs/cli/tests/e2e/packaged-cli.test.ts` builds and exercises the packaged executable, but does
  not cover the complete lifecycle, crash recovery, profiles, completion, or production-faithful
  Windows self-update.
- `libs/cli/tests/integration/library-lifecycle.test.ts` exercises a local Git-backed lifecycle.
- `libs/cli/tests/integration/dogfood-openspec.test.ts` checks repository skill fixtures.
- Package metadata and allowlisting are defined by `libs/cli/package.json`, build configuration,
  and workspace release scripts.
- Public behavior is documented independently in `README.md`, `skills/skill-sync/SKILL.md`,
  `apps/wiki/src/content/docs/`, and `apps/wiki/src/data/commands.ts`.

### Coordinated work already present

The pre-existing dirty files for updater/version behavior include
`application/release-management.ts`, `infrastructure/npm-registry.ts`,
`infrastructure/npm-updater.ts`, `infrastructure/package-metadata.ts`, command/TUI wiring, packaged
and unit tests, package metadata, README, bundled skill, and wiki pages. The active OpenSpec changes
`add-cli-update-and-version-check` and `release-on-main-merge` remain the source of their original
requirements until task 12.7 records whether they were incorporated or superseded.

## Baseline results

Measured on macOS arm64 with Node 24.18.0 and npm 11.16.0. Commands were read-only; Nx cache
status is noted where it materially affected wall time.

| Surface | Result | Measured wall time | Initial regression ceiling |
| --- | --- | ---: | ---: |
| `npm run typecheck` | passed; CLI and wiki, 0 diagnostics | 9.99 s | 15 s |
| `npm run lint` | passed; CLI and wiki, 0 warnings | 7.49 s | 12 s |
| `npm run test:unit` | 36 files, 189 tests passed; Nx cache hit | 0.72 s; Vitest report 5.49 s | 10 s uncached |
| `npm run test:integration` | 2 files, 10 tests passed | 24.02 s | 35 s |
| `npm run test:e2e` | 1 file, 2 tests passed | 5.07 s | 10 s |
| `npm run smoke:pack` | passed | 8.88 s | 15 s |
| `npm run wiki:build` | 19 pages built | 4.97 s | 10 s |
| packaged `--help` startup | 10-run median 241.2 ms; 217.2–259.3 ms | 241.2 ms | 350 ms median |
| packaged `version` startup | 10-run median 237.1 ms; 232.8–247.5 ms | 237.1 ms | 350 ms median |

The ceilings above are provisional local regression sentinels, not cross-platform CI limits. Task
11.4 must replace them with fixture-backed, per-platform budgets and document allowed variance.

Coverage has no configured provider, script, report, or threshold (`@vitest/coverage-v8` is not
installed), so the measurable baseline is “not collected.” Task 11.4 must introduce report-only
collection before ratcheting enforceable per-layer thresholds.

There is no benchmark target beyond the startup measurements above, and no file-descriptor, memory,
Git-call-count, catalog, hashing, or batch fixture. Those missing measurements are explicit baseline
gaps for task 11.4.

The current CI matrix runs `npm run check` on Ubuntu, macOS, and Windows with Node 22 and 24.
Windows-specific local fixtures cover path resolution, temporary-directory prefixes, and packaged
process spawning, while the package smoke script uses `npm.cmd` with `shell: true`. This macOS
session cannot claim a Windows runtime pass; task 11.3 must add production-faithful Windows updater
coverage and task 12.6 must record actual OS acceptance evidence.

## Novice static completion slice

Completed on 2026-08-03 for task 8.5. `completion --shell bash|zsh|fish|powershell` now renders raw,
deterministic static scripts from the typed leaf, parent, inherited-option, help, argument-choice,
and option-choice metadata. Completion has a dedicated program-layer handler, so ordinary output is
sourceable and bypasses application execution, startup recovery inspection, configuration, cache,
project/global state, prompts, progress, and network access. JSON mode returns the same script with
its selected shell in the normal versioned envelope.

Verification added in `completion.test.ts`, `command-registry.test.ts`, `program.test.ts`, the
packaged CLI end-to-end suite, and the globally installed tarball smoke. The tests pin deterministic
script byte counts and SHA-256 digests, cover representative root/nested/argument/option candidates,
choice and `--option=value` forms, path-only value slots, free-form values, and `--` separators.
They syntax-check installed shells locally, require Bash, Zsh, Fish, and PowerShell parsing in a
dedicated Linux CI job, prove no application executor call, and prove generation from an unrelated
directory creates no application-state directory. The packaged suite also pins the exact missing
and invalid `--shell` guidance and rejects unrelated scope, confirmation, and prompt flags without
creating state. Authored README, bundled skill, wiki installation/reference/automation guidance,
and the searchable command catalog document current-session and conservative persistent setup for
all four shells.

The macOS acceptance pass uses the system Bash 3.2 rather than assuming a newer shell. It verifies
the documented `/dev/stdin` activation command, whitespace-preserving directory candidates, and
filename-mode registration so directory completion quotes spaces and retains a trailing slash. A
runtime Zsh probe also verifies path completion for both `--project <path>` and
`--project=<path>` forms.

The same slice makes an offline `status` cache miss explain the exact recovery action: retry that
status command without `--offline` when remote access is available. Provider and workflow tests
prove the failing cache-only path does not refresh, validate a checkout, stage reconciliation, or
change the managed manifest, lockfile, installed copy, or project tree.

## Novice setup and reconciliation presentation slice

Continued on 2026-08-03 as partial progress toward tasks 8.1 and 8.7. The first-run TUI connect and
create forms now validate input before invoking lifecycle actions. Invalid text remains available
for correction beside an inline safe example; editing, deleting, Escape, or a successful submission
clears the error. Connect validation reuses credential-free Git remote normalization, distinguishes
embedded credentials from malformed remotes, and create validation reuses the lifecycle's GitHub
`owner/name` contract. Controller, renderer, full TUI, and packaged interactive checks cover both
forms.

Project and global `sync`/`update` human results now share a deterministic renderer. It reports the
mode, freshness, overall result, selected and per-outcome counts, unique write and backup counts,
and at most 20 sorted skill rows with an omitted count. Displayed failures retain their stable code
and safe message. Every result ends with a project- or global-scope action for applying a preview,
inspecting a skipped skill, retrying a failure, verifying status, or confirming that no change is
needed. JSON reports remain unchanged and unbounded. Service and workflow tests cover clean global
apply, project partial success, rollback-backed individual failure, check-mode drift, and detail
bounds. Task 8.1 remains open until the recovery and remaining renderer architecture work is done.
At this checkpoint, task 8.7 still awaited the plan-backed setup work recorded below.

The same continuation improves the two earliest setup failure paths. A mistaken top-level `setup`
or `create` now returns the exact existing-library or create-library `init` command before startup
recovery and application I/O, while ordinary safe typo suggestions remain unchanged. Packaged
human and JSON checks verify stable command attribution, a single JSON envelope, and no
configuration-state creation. A failed `init` remote probe now retains a bounded sanitized Git
reason, common repository-access guidance, and an HTTPS credential or SSH key/host next step under
the existing `REMOTE_ACCESS_FAILED` contract. Infrastructure, lifecycle, and workflow tests cover
control-sequence removal, secret redaction, result bounds, output parity, and unchanged config,
cache, staging, and project state. These are further partial progress toward novice-readable errors;
they do not close tasks 8.1 or 8.7.

The semantic setup guidance preserves the CLI's existing global version precedence even when
`setup` or `create` also appears. A no-input `init` now names both accepted inputs, and its
interactive prompt says repository rather than implying that existing libraries must be hosted on
GitHub. For `init --create`, a post-creation access-probe failure explicitly warns that the GitHub
repository may remain while local configuration, cache, staging, and project state stay untouched.
Packaged and lifecycle regressions cover these boundaries.

An `INCOMPATIBLE_LIBRARY` result for a reachable nonempty repository now also states its precise
safety boundary and the three valid next routes. It guarantees that remote contents and saved
library configuration remain unchanged without incorrectly promising that validation left the
local cache untouched. Integration and workflow tests retain the validation exit contract, remote
HEAD, configuration, output parity, and unrelated project state.

Recovery presentation is now isolated in `ui/recovery-output.ts` rather than application recovery
discovery. Human list, inspect, resume, restore, and prune results use deterministic 20-row bounds,
explicit read-only/preview/complete state, scope and count labels, plain-language action names,
omitted counts, fingerprints where applicable, and a safe next step. Terminal journals and verified
backups are labeled cleanup-only; large prune selections refer to the reviewed selection rather
than printing an unbounded pseudo-command. Default-executor parity checks prove the underlying JSON
plans stay unchanged. This is further partial progress toward task 8.1, which remains open until
the remaining presentation paths are separated from application and orchestration code.

The first-run TUI now separates input from authorization for both setup routes. Valid connect or
create input opens a review screen; only `y` invokes the existing `init` command path, while Escape
returns to the editable value. Connect review identifies remote-content safety, local cache and
configuration effects, the normalized credential-free URL, and the separate empty-remote decision. Create review names the fixed
private/HTTPS/`main` choices, external repository creation and initial push, and the possibility
that the external repository remains after a later access failure. Setup command construction is
also scope-free: a dashboard opened with `--project` or `--global` still configures the user-wide
library without forwarding an option that `init` rejects. Exact project/global invocation tests,
navigation tests, and renderer tests cover the boundary. At this checkpoint, task 8.7 still awaited
the typed dry-run plan and fingerprint revalidation work recorded below.

Fresh `list` and uninstalled `info` results now end in a preview-ready install command rather than
an incomplete command that first fails for target selection and then fails again for project
gitignore policy. The next action prefers Codex when declared compatible, falls back to Claude,
includes `--gitignore` for project scope, uses the scope-correct policy-free global form, and always
includes `--dry-run`. Stale results continue to direct the user back to remote refresh instead of a
mutation. Empty configured project/global status now points to that preview-ready `list` handoff
instead of printing another incomplete install placeholder. Focused project, global,
alternate-target, stale, packaged, and JSON-parity tests cover the change. A successful canonical
ID validation likewise routes through `info` for compatibility and the complete preview instead of
suggesting an underspecified install. Task 8.1 remains open because other human presentation still
lives in application and orchestration modules.

Doctor presentation is now isolated in `ui/doctor-output.ts`; the application service returns only
the structured `DoctorReport`. Human diagnostics report all four status counts, show at most 20
failure-first checks with an omitted count, preserve plain/color semantic labels, number visible
failure and warning remedies, and always end with a relevant next action for repair, completing
offline checks, or healthy scope browsing. The JSON report and exit mapping are unchanged and
unbounded. Focused renderer, handler parity, color, and bound tests cover the extraction. This is
further partial progress toward task 8.1, which remains open while other renderers still live in
application and orchestration modules.

Install presentation is now isolated in `ui/install-output.ts`. Dry-run and interactive review
output deliberately remains complete because it is the authorization plan: every selected skill
and destination stays visible. A true no-op preview no longer offers a meaningless fingerprinted
apply; it says that all selected targets are already installed and points to the scope-correct
status command. Non-dry human results label writes as completed, sort skill IDs, show at most 20
skills with an omitted count, and retain `skill-sync --global status` after global work. JSON
results remain unchanged and unbounded. Focused renderer and workflow tests cover no-op previews,
large review/final results, project/global handoffs, and JSON parity. This is additional progress
toward task 8.1, which remains open.

Uninstall presentation is likewise isolated in `ui/uninstall-output.ts`. Review output keeps every
selected skill and destination, while non-dry summaries sort and cap skill rows at 20, report
omissions, label completed writes, and distinguish backups that were created from backups merely
required by a preview. Completion, cancellation, and retry handoffs preserve global scope instead
of silently running project `status`. JSON results are unchanged and unbounded. Focused renderer
and workflow tests cover large previews/final results, cancellation, backup wording, project/global
handoffs, and structured parity. Task 8.1 remains open for the other embedded renderers.

The status reached after removing the final project or global skill now keeps the same runnable
catalog handoff as a never-managed configured scope: run the scope-correct `list` command and follow
its preview-ready install command. It no longer prints an underspecified `<id>` install that omits
target selection and project `.gitignore` policy. The global install/uninstall regression follows
through to this zero-managed-state result.

Adoption presentation is now isolated in `ui/adopt-output.ts`. Dry-run output labels planned
tracking writes while reaffirming that target files are unchanged; applied output labels completed
tracking writes. The final verification command preserves global scope, closing the same silent
wrong-scope trap found after global install and uninstall. Renderer and workflow tests cover stale
project previews, structured global previews, successful global apply, unchanged target bytes, and
scope-correct handoff. Task 8.1 remains open for the other inline renderers.

Human follow-up commands now preserve an explicit project selection instead of silently falling
back to the caller's current directory. A shared presentation helper renders
`--project <project-path>` without interpolating an untrusted filesystem path; the result's existing
`Project` or `Scope` line supplies the value to substitute. Empty status, list/info handoffs,
install, adoption, uninstall, project status/diff, and reconciliation all carry this context, while
global list stale/no-match guidance likewise retains global scope. Structured results remain
unchanged. Focused renderer, workflow, and packaged empty-status tests cover implicit, explicit,
global, configured, unconfigured, stale, filtered, preview, apply, and cancellation paths.

The same explicit-project context now reaches publish completion and healthy doctor browsing, so
their final status/list handoffs cannot switch checkouts. Project paths remain placeholders backed
by the result's labeled path rather than interpolated shell content. JSON reports remain unchanged.

Orphaned skills now have a terminating human workflow. Project and global status, diff, and skipped
reconciliation explain that the canonical ID no longer exists and point to a scope-preserving
`uninstall <id> --dry-run` preview or restoration of the canonical skill. They no longer recommend
`sync`, which deterministically skips orphaned entries and previously returned the user to the same
diff/sync loop. Focused project/global presentation regressions cover all three entry points.

Validation handoffs now retain both subject and scope. A failed explicit ID or local path points to
`validate <same-id-or-path>` rather than bare `validate`, which would inspect the configured catalog
instead. Successful catalog, canonical-ID, and installed-copy guidance uses the same project,
explicit-project, or global command context for `list`, `info`, and `status`. The structured
validation report and JSON failure details are unchanged; formatter and workflow regressions cover
default, explicit-project, global, valid, and invalid results.

Destructive human dry-run handoffs now account for prompt capability. Noninteractive canonical and
group removals, recovery resume/restore/prune, and uninstalls that require a local-work backup name
`--yes` in the printed apply step instead of pointing to a command that will be refused. Interactive
wording, safe uninstalls, and structured JSON contracts remain unchanged; focused formatter and
handler regressions cover each boundary.

Interactive install previews now distinguish their continuation from standalone dry-runs. The
preview emitted inside an already-running interactive install points to the current confirmation
prompt and explicitly says that no second command is needed. Standalone `install --dry-run` output
now prints a complete `Next:` apply command derived from the resolved exact qualified IDs or the
original `--all` selection, deterministically sorted repeated targets, the resolved project
gitignore policy when applicable, project/global scope, and `--expect-plan install-v1-...`.
Explicit project invocations preserve the safe `--project <project-path>` placeholder backed by the
labeled path.
Formatter and workflow regressions cover selected-ID, all-selection, target ordering, policy,
project/global scope, and placeholder behavior. The handler also recognizes an inline no-op and
returns its scope-correct status guidance without displaying a confirmation prompt or entering the
apply path.

A design audit established the requirements for promoting the first-run setup review from an
effects request into a typed application plan. A sound `init-v1` fingerprint requires disposable
OS-temporary remote inspection, full library validation, exact revision/configuration/effect
binding, cleanup on every exit, and apply-time revalidation under shared cache/configuration
coordination. GitHub create planning must additionally distinguish a missing repository from
authentication, authorization, and network failures before any external mutation.

The first `init-v1` application-plan slice is now implemented. `init --dry-run` inspects an
existing remote in disposable OS-temporary Git storage, validates its complete exact-revision
library tree, binds normalized intent, branch, revision, full before/after configuration, create
settings, and effects into a deterministic fingerprint, and cleans up without writing persistent
cache or configuration state. `--expect-plan` re-plans under lifecycle coordination, refuses
remote or configuration drift with `INIT_PLAN_CHANGED`, and applies through the same lifecycle
path. GitHub creation now has a conservative read-only preflight: authentication and ambiguous
lookup failures stop before creation rather than being treated as a missing repository.

The first-run TUI now consumes that structured plan through ordinary `init --dry-run` command
execution, renders application-owned remote/revision/configuration/effect facts, re-previews on
confirmation, and returns changed plans to review before accepting a second `y`. Empty repository
initialization is an action in the same plan instead of an error-driven second review path. CLI,
TUI, lifecycle, parser, renderer, and disposable-inspection regressions cover all three actions and
stale-plan recovery. Real `init`, `config set`, and `config unset` commands now also share one
crash-visible advisory lock across processes, while dry-run setup remains lock-free; a focused
executor regression covers contention, guidance, release, and preview behavior.

Direct CLI setup now follows the same review boundary. Interactive human use prints the complete
plan before confirmation; when confirmation is unavailable, an unconfirmed `init` returns that
write-free plan instead of silently applying it. `--expect-plan` remains the exact reviewed apply
path, while explicit `--yes` is the intentional one-command automation opt-in.

Reviewed connect applies now retain the disposable repository used to build the accepted plan and
promote that exact commit instead of performing a general persistent refresh. Exact promotion
verifies the prepared commit and branch, rechecks the remote branch before persistent writes, then
imports the reviewed object and publishes its validated snapshot and cache state under cache
coordination. Remote drift is translated to `INIT_PLAN_CHANGED`; focused cache and lifecycle
regressions prove that drift detected at this boundary leaves both persistent cache and saved
configuration absent or unchanged.

Initialization now receives the command-scoped cancellation signal from the workflow boundary and
preserves it through disposable Git inspection and safety-directory rebinding, GitHub preflight and
creation, remote push, and cache promotion or refresh. A commit-aware guard checks cancellation
before each provider, push, and configuration effect and prevents an interruption after a confirmed
external effect from being reported as an ordinary pre-commit cancellation.

CLI-backed initialization also writes a v2 `library-initialization` journal before those external
effect boundaries. Its structured, credential-redacted note records the reviewed plan, remote, branch, expected
revision, provider creation, initial push, configuration states, and any boundary failure or signal.
Failure before any effect attempt removes the write-ahead record. Successful initialization removes
its record and older matching initialization evidence for the same remote; an interrupted or failed
effect remains visible in `recovery list` and `recovery inspect` as an intentionally inspect-only record. Human inspection
explains that external repository changes are never replayed or deleted automatically, shows the
recorded effect states, and directs the user to inspect the provider and branch before generating a
fresh `init --dry-run` plan and applying its exact printed `--expect-plan` command.

Production cache refresh and exact promotion now compose the process-local queue with a
crash-visible, identity-scoped filesystem lock. A competing process cannot publish the same cache
identity concurrently, while `inspect()` bypasses the lock seam and remains strictly write-free.
Child-process contention and production executor wiring have focused regression coverage.

Public recovery guidance and the searchable command catalog now cover the explicit abandoned-lock
exit path. `recovery unlock <id>` is documented as a singular, scope-less, preview-first action:
owned advisory locks refresh their persisted lock-file mtime heartbeat every 15 seconds, and it
requires same-host dead-PID proof plus a fixed 60-second crash grace measured from the later of
metadata creation and that last persisted heartbeat. It also requires interactive confirmation or
explicit `--yes` and immediate revalidation of the exact path, full owner metadata, grace, and plan
fingerprint before removing only the selected lock. Confirmed applies serialize per stable record
on a crash-visible recovery action lock and sync the selected lock's parent directory before
reporting success. An ambiguous parent-directory sync preserves that action lock as discoverable
evidence rather than claiming clean completion. Recovery inspection and preview JSON project only
safe owner fields and never expose the internal `ownerToken`. Unit, executor, output, and true
cross-process regressions cover the heartbeat baseline and grace refusal, competing apply,
durable-boundary evidence, redaction, and successful exact removal. README, bundled skill, recovery
reference, conflict, troubleshooting, security, automation, and searchable catalog guidance
consistently state that active, foreign-host, too-young, malformed, changed, or otherwise
unverifiable evidence is refused and preserved, and that manual lock deletion is never a fallback.

`doctor` now includes the same read-only application recovery discovery in human, JSON, offline,
and TUI reports. A clean store passes; valid locks, incomplete journals, or backups produce a
counted warning; malformed or unsafe evidence fails locally. Every non-passing check hands off to
`recovery list` and `recovery inspect <id>` without creating, repairing, or deleting recovery state.

The first-run dashboard now initializes install targets from the effective configured defaults for
both project and global scope, accepts the valid target set intact, and falls back to Codex only
when no valid target set is available. Create explicitly identifies that the new library starts
empty. Successful setup with skills opens the catalog with `Space` selection and `i` install-review
guidance; successful empty setup stays on the overview with the exact
`skill-sync add <path> --dry-run` author preview. The catalog separately identifies a truly empty
library and a search/group filter with no matches, and only the former suggests adding a skill.
Controller, runner, and app regressions cover the configured-default, project/global, setup-routing,
and empty-state boundaries.

Task 8.7 is complete. Whether initialization recovery evidence is resumable or restorable belongs
to the durable-recovery work and is not an acceptance criterion for the first-run workflow.

Novice discovery now declares `show` as the read-only registry alias for `info`, including `info`
command attribution in dispatch and JSON. Unknown syntactically valid selectors retain only the
best-distance candidates, sort exact IDs deterministically, cap the result at three, require edit
distance at most 2 and similarity at least 60%, and never auto-resolve. Human `info` failures emit a
scope-correct exact `info` retry for one candidate, exact `info` choices for ambiguity, or the
scope-correct `list` fallback; JSON preserves the structured candidates without human next-step
text. Shared mutation selection still returns no values when any selector fails, exposes candidates
only as advisory error data, performs no writes, and never reconstructs a fuzzy mutation command.
Registry, completion, selector, read-only catalog, workflow, and packaged CLI regressions cover the
alias, bounds, project/global guidance, structured output, and fail-closed mutation boundary.

Tasks 2.11, 8.7, 8.11, and 8.12 passed the combined root-level gate: formatting, lint, CLI and wiki
typechecking, wiki production build, 453 CLI tests across 56 files, and the packed CLI smoke suite.
The strict OpenSpec validator and final diff-integrity check also pass.

## Compatibility matrix

Schema versions are independent. A journal, config, managed-state, cache, library, and JSON version
must never be inferred from another schema's number.

| Surface | Existing form | New form | Read behavior | Write/apply behavior | Recovery or rollback checkpoint |
| --- | --- | --- | --- | --- | --- |
| Operation journal | v1 destination/action/state entries | v2 root fingerprint, deterministic candidate/rollback paths, digests, per-entry and terminal evidence | v1 remains discoverable and inspectable; v2 is fully validated | v1 is never replayed, guessed, auto-migrated, or pruned; all new mutations write v2 | Land the dual reader and inspect-only classification before the v2 writer; keep v1 fixtures permanently |
| User configuration | v1 optional single `library` plus defaults | v2 named profiles, selected profile, and existing defaults | Read-only commands interpret v1 as an implicit legacy default without writing | First config/profile mutation validates v1, creates a recoverable backup, and atomically writes equivalent v2; subsequent writes remain v2 | Land dual parsing and v1→v2 round-trip tests before profile commands; a failed migration leaves the exact v1 bytes active |
| Project managed state | v1 identity-only manifest/lock pair | v2 may add a credential-free project connection while retaining managed identity | Valid v1 identity-only state remains readable; enrichment requires an independently resolved matching identity | No command silently retargets state; enrichment is explicit or derives only from an identity-matching source and writes the manifest/lock pair atomically | Land shared v1 pair validation before v2 enrichment; on mismatch or missing source, preserve both v1 files unchanged |
| Global managed state | v1 project-derived manifest/lock schemas | compatible next schema using the shared state-pair contract | Existing valid pairs remain readable under the shared loader | Migration occurs only through a locked, journaled mutation and preserves library identity | Shared loader and conformance fixtures must pass before replacing global-specific parsing |
| JSON envelope | current schema version 1; `version` bypasses it and some parser failures have incorrect attribution | independently versioned envelope plus named command-data schemas | Continue accepting no input schema; emit one documented envelope per invocation | Correct `--json version` and parser attribution immediately; bump the envelope or affected data schema before any incompatible field removal/change | Characterization snapshots precede migration; release notes distinguish compatibility corrections from incompatible schema changes |
| Library/cache schemas | library v1 and cache state v1 | no version bump in the early recovery phase | Continue strict v1 reads with identity and digest validation | Change only when resource/profile requirements need new persisted fields; use isolated identity paths and atomic publication | Existing verified snapshots remain usable; incompatible cache entries fail closed and may be repopulated, never silently relabeled |

Implementation checkpoints:

1. Freeze v1 fixtures and current JSON behavior, including known `version` and parser-attribution
   defects.
2. Land dual journal reading, v1 inspect-only classification, and mutation blocking before any v2
   journal can be created.
3. Land and fault-test the v2 journal writer before recovery resume/restore is enabled.
4. Land the shared v1 project/global state-pair loader before schema enrichment or orchestration
   consolidation.
5. Land the typed command registry and JSON snapshots before rejecting formerly ignored options or
   correcting attribution.
6. Land dual user-config reading and reversible v1→v2 serialization before profile commands can
   write configuration.
7. Preserve old readers until packaged migration fixtures pass on every supported operating system;
   rollback to a prior npm release must not delete or reinterpret newer durable evidence.
