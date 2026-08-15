import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectRegularFileTree, type RegularFileInventoryEntry } from '../domain/digest.js';
import { comparePortableStrings } from '../domain/identifiers.js';
import {
  canonicalizeProjectLock,
  PROJECT_LOCK_FILENAME,
  PROJECT_MANIFEST_FILENAME,
  type ProjectLock,
  type ProjectManifest,
  type ResolvedSkill,
} from '../domain/project-state.js';
import {
  classifyReconciliation,
  type ReconciliationAssessment,
  type ReconciliationState,
} from '../domain/reconciliation.js';
import { EXIT_CODES, SkillSyncError, redactSecrets, type ExitCode } from '../domain/result.js';
import { validateLibrary, type ValidatedSkill } from '../domain/library.js';
import {
  isRecoveryIntegrityError,
  isTransactionRolledBackError,
} from '../domain/recovery-integrity.js';
import type { NormalizedGitRemote } from '../infrastructure/git.js';
import { GitClient, type GitProcessResult, type GitRunOptions } from '../infrastructure/git.js';
import {
  type LibraryCacheFreshness,
  type LibraryCacheInspectRequest,
  type LibraryCacheRefreshRequest,
  type LibraryCacheRevision,
} from '../infrastructure/library-cache.js';
import {
  readProjectLock,
  readProjectManifest,
  resolveContainedProjectPath,
} from '../infrastructure/project-state.js';
import { loadManagedStatePair } from '../infrastructure/managed-state.js';
import { stableJsonStringify } from '../infrastructure/stable-json.js';
import {
  acquireAdvisoryLock,
  createRecoverableBackup,
  createStagingDirectory,
  replacePathsAtomically,
  stageRegularPath,
  type AtomicReplacement,
} from '../infrastructure/transactions.js';
import type { OperationGuard } from '../runtime/operation-guard.js';
import { resolveSkillSelectors, selectAllSkills } from './selectors.js';
import type { ProjectMutationStorage } from './project-installation.js';

const FULL_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface ReconciliationGitPort {
  run(arguments_: readonly string[], options?: GitRunOptions): Promise<GitProcessResult>;
}

export interface ReconciliationCachePort {
  refresh(request: LibraryCacheRefreshRequest): Promise<LibraryCacheRevision>;
  inspect?(request: LibraryCacheInspectRequest): Promise<LibraryCacheRevision>;
}

export type LibraryRevisionPurpose = 'inspection' | 'application';

export interface LibraryRevisionRequest {
  readonly allowStale?: boolean;
  readonly cacheOnly?: boolean;
  readonly offlineRevision?: string;
  readonly purpose: LibraryRevisionPurpose;
}

export interface ResolvedLibraryRevision {
  readonly branch: string;
  readonly freshness: LibraryCacheFreshness;
  readonly identity: string;
  readonly libraryRoot: string;
  readonly refreshedAt: string;
  readonly revision: string;
  readonly stale: boolean;
  readonly usableForMutation: boolean;
  readonly warning?: { readonly code: string; readonly message: string };
  release?(): Promise<void>;
}

export interface LibraryRevisionProvider {
  resolve(request: LibraryRevisionRequest): Promise<ResolvedLibraryRevision>;
}

export interface CachedLibraryRevisionProviderOptions {
  readonly branch?: string;
  readonly cache: ReconciliationCachePort;
  readonly git?: ReconciliationGitPort;
  readonly remote: NormalizedGitRemote;
  readonly stagingRoot: string;
}

function reconciliationError(
  code: string,
  message: string,
  exitCode: ExitCode,
  details?: Readonly<Record<string, unknown>>,
): SkillSyncError {
  return new SkillSyncError(code, message, exitCode, details);
}

function safeMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * Resolve a cache revision and materialize only that exact commit into a disposable checkout.
 * Git hooks, filters, global configuration, and submodules remain disabled by the Git adapter.
 */
export class CachedLibraryRevisionProvider implements LibraryRevisionProvider {
  private readonly branch: string | undefined;
  private readonly cache: ReconciliationCachePort;
  private readonly git: ReconciliationGitPort;
  private readonly remote: NormalizedGitRemote;
  private readonly stagingRoot: string;

  public constructor(options: CachedLibraryRevisionProviderOptions) {
    this.branch = options.branch;
    this.cache = options.cache;
    this.git = options.git ?? new GitClient();
    this.remote = options.remote;
    this.stagingRoot = options.stagingRoot;
  }

  public async resolve(request: LibraryRevisionRequest): Promise<ResolvedLibraryRevision> {
    let cached: LibraryCacheRevision;
    try {
      if (request.cacheOnly === true) {
        if (request.purpose !== 'inspection' || request.offlineRevision !== undefined) {
          throw new Error('Cache-only mode is restricted to inspection without an exact revision.');
        }
        if (this.cache.inspect === undefined) {
          throw new Error('The configured cache does not support write-free inspection.');
        }
        cached = await this.cache.inspect({
          ...(this.branch === undefined ? {} : { branch: this.branch }),
          remote: this.remote,
        });
      } else {
        cached = await this.cache.refresh({
          access: request.purpose === 'application' ? 'mutation' : 'read-only',
          ...(request.allowStale === undefined ? {} : { allowStale: request.allowStale }),
          ...(this.branch === undefined ? {} : { branch: this.branch }),
          ...(request.offlineRevision === undefined
            ? {}
            : { offlineRevision: request.offlineRevision }),
          remote: this.remote,
        });
      }
    } catch (error) {
      const offlineGuidance =
        request.cacheOnly === true
          ? ' Re-run this status command without --offline when remote access is available to populate a verified cache.'
          : '';
      throw reconciliationError(
        'LIBRARY_REVISION_UNAVAILABLE',
        `Unable to resolve the library revision: ${safeMessage(error)}${offlineGuidance}`,
        EXIT_CODES.repository,
      );
    }

    if (cached.treeDirectory !== undefined) {
      return {
        branch: cached.branch,
        freshness: cached.freshness,
        identity: cached.identity,
        libraryRoot: cached.treeDirectory,
        refreshedAt: cached.refreshedAt,
        revision: cached.revision,
        stale: cached.stale,
        usableForMutation: cached.usableForMutation,
        ...(cached.warning === undefined ? {} : { warning: cached.warning }),
      };
    }

    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const checkout = await mkdtemp(join(this.stagingRoot, 'reconcile-library-'));
    try {
      await this.git.run(['init', '--quiet', checkout], { profile: 'content' });
      await this.git.run(['remote', 'add', 'cache', cached.repositoryDirectory], {
        cwd: checkout,
        profile: 'content',
      });
      await this.git.run(
        ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'cache', cached.revision],
        { cwd: checkout, profile: 'content' },
      );
      await this.git.run(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], {
        cwd: checkout,
        profile: 'content',
      });
      const head = await this.git.run(
        ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
        { cwd: checkout, profile: 'content' },
      );
      if (head.stdout.trim().toLowerCase() !== cached.revision.toLowerCase()) {
        throw new Error('The disposable checkout did not resolve to the requested exact commit.');
      }
    } catch (error) {
      await rm(checkout, { recursive: true, force: true });
      throw reconciliationError(
        'LIBRARY_MATERIALIZATION_FAILED',
        `Unable to materialize the selected library revision: ${safeMessage(error)}`,
        EXIT_CODES.repository,
      );
    }

    let released = false;
    return {
      branch: cached.branch,
      freshness: cached.freshness,
      identity: cached.identity,
      libraryRoot: checkout,
      refreshedAt: cached.refreshedAt,
      revision: cached.revision,
      stale: cached.stale,
      usableForMutation: cached.usableForMutation,
      ...(cached.warning === undefined ? {} : { warning: cached.warning }),
      release: async () => {
        if (released) return;
        released = true;
        await rm(checkout, { recursive: true, force: true });
      },
    };
  }
}

export interface DestinationStatus {
  readonly changedFromBase: boolean;
  readonly changedFromRecorded: boolean;
  readonly digest?: string;
  readonly exists: boolean;
  readonly inspectionError?: string;
  readonly inventory: readonly RegularFileInventoryEntry[];
  readonly path: string;
  readonly recordedDigest: string;
  readonly target: string;
}

export interface ProjectSkillStatus {
  readonly assessment: ReconciliationAssessment;
  readonly baseDigest: string;
  readonly canonicalDigestRecorded: string;
  readonly destinations: readonly DestinationStatus[];
  readonly id: string;
  readonly libraryDigest?: string;
  readonly state: ReconciliationState;
}

export interface ProjectStatusReport {
  readonly authoritative: boolean;
  readonly branch: string;
  readonly freshness: LibraryCacheFreshness;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operation: 'status';
  readonly projectRoot: string;
  readonly refreshedAt: string;
  readonly skills: readonly ProjectSkillStatus[];
  readonly stale: boolean;
  readonly warning?: { readonly code: string; readonly message: string };
}

export type FileDifferenceKind = 'different' | 'library-only' | 'local-only' | 'unreadable';

export interface FileDifference {
  readonly kind: FileDifferenceKind;
  readonly librarySha256?: string;
  readonly localSha256?: string;
  readonly path: string;
}

export interface TargetDifference {
  readonly destination: string;
  readonly differences: readonly FileDifference[];
  readonly digest?: string;
  readonly divergentFromOtherTargets: boolean;
  readonly exists: boolean;
  readonly target: string;
}

export interface ProjectDiffReport {
  readonly authoritative: boolean;
  readonly baseDigest: string;
  readonly branch: string;
  readonly canonicalDigestRecorded: string;
  readonly freshness: LibraryCacheFreshness;
  readonly id: string;
  readonly libraryDigest?: string;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operation: 'diff';
  readonly projectRoot: string;
  readonly stale: boolean;
  readonly state: ReconciliationState;
  readonly targets: readonly TargetDifference[];
  readonly warning?: { readonly code: string; readonly message: string };
}

export interface ProjectInspectionOptions {
  readonly allowStale?: boolean;
  readonly library: LibraryRevisionProvider;
  readonly offline?: boolean;
  readonly offlineRevision?: string;
  readonly projectRoot: string;
}

export interface ProjectDiffOptions extends ProjectInspectionOptions {
  readonly selector: string;
}

interface ProjectSnapshot {
  readonly lock: ProjectLock;
  readonly manifest: ProjectManifest;
  readonly projectRoot: string;
}

interface RevisionInspection {
  readonly libraryById: ReadonlyMap<string, ValidatedSkill>;
  readonly revision: ResolvedLibraryRevision;
  readonly snapshot: ProjectSnapshot;
  readonly statuses: readonly ProjectSkillStatus[];
}

async function readSnapshot(projectRootInput: string): Promise<ProjectSnapshot> {
  const projectRoot = await realpath(projectRootInput);
  const { lock, manifest } = await loadManagedStatePair({
    readLock: async () => await readProjectLock(projectRoot),
    readManifest: async () => await readProjectManifest(projectRoot),
    required: true,
    resolveDestination: async (projection) =>
      await resolveContainedProjectPath(projectRoot, projection.destination),
    scope: 'project',
  });
  if (manifest === undefined || lock === undefined) {
    throw new Error('Required project state was not returned by the managed-state loader.');
  }
  return { lock, manifest, projectRoot };
}

function invalidTreeDigest(path: string): string {
  return `invalid-tree:${path}`;
}

async function inspectDestination(
  projectRoot: string,
  baseDigest: string,
  projection: ResolvedSkill['projections'][number],
): Promise<DestinationStatus> {
  const destination = await resolveContainedProjectPath(projectRoot, projection.destination);
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        changedFromBase: false,
        changedFromRecorded: false,
        exists: false,
        inventory: [],
        path: projection.destination,
        recordedDigest: projection.digest,
        target: projection.target,
      };
    }
    throw error;
  }

  try {
    const tree = await inspectRegularFileTree(destination, { rejectNestedSkillRoots: true });
    return {
      changedFromBase: tree.digest !== baseDigest,
      changedFromRecorded: tree.digest !== projection.digest,
      digest: tree.digest,
      exists: true,
      inventory: tree.files,
      path: projection.destination,
      recordedDigest: projection.digest,
      target: projection.target,
    };
  } catch (error) {
    const digest = invalidTreeDigest(projection.destination);
    return {
      changedFromBase: true,
      changedFromRecorded: true,
      digest,
      exists: true,
      inspectionError: safeMessage(error),
      inventory: [],
      path: projection.destination,
      recordedDigest: projection.digest,
      target: projection.target,
    };
  }
}

async function assessResolvedSkill(
  projectRoot: string,
  resolved: ResolvedSkill,
  librarySkill: ValidatedSkill | undefined,
): Promise<ProjectSkillStatus> {
  const destinations = await Promise.all(
    [...resolved.projections]
      .sort(
        (left, right) =>
          left.target.localeCompare(right.target) ||
          left.destination.localeCompare(right.destination),
      )
      .map(
        async (projection) =>
          await inspectDestination(projectRoot, resolved.baseDigest, projection),
      ),
  );
  const assessment = classifyReconciliation({
    baseDigest: resolved.baseDigest,
    destinations: destinations.map((destination) => ({
      ...(destination.digest === undefined ? {} : { digest: destination.digest }),
      exists: destination.exists,
      path: destination.path,
      target: destination.target,
    })),
    libraryDigest: librarySkill?.digest,
  });
  return {
    assessment,
    baseDigest: resolved.baseDigest,
    canonicalDigestRecorded: resolved.canonicalDigest,
    destinations,
    id: resolved.id,
    ...(librarySkill === undefined ? {} : { libraryDigest: librarySkill.digest }),
    state: assessment.state,
  };
}

async function inspectRevision(
  snapshot: ProjectSnapshot,
  revision: ResolvedLibraryRevision,
): Promise<RevisionInspection> {
  if (snapshot.manifest.library.identity !== revision.identity) {
    throw reconciliationError(
      'PROJECT_LIBRARY_MISMATCH',
      `Project library ${snapshot.manifest.library.identity} does not match resolved library ${revision.identity}.`,
      EXIT_CODES.validation,
    );
  }
  if (!FULL_OBJECT_ID.test(revision.revision)) {
    throw reconciliationError(
      'INVALID_LIBRARY_REVISION',
      'The resolved library revision is not an exact Git object ID.',
      EXIT_CODES.repository,
    );
  }

  const validation = await validateLibrary(revision.libraryRoot);
  if (!validation.valid) {
    throw reconciliationError(
      'INVALID_LIBRARY',
      'The selected library revision is invalid and cannot be reconciled.',
      EXIT_CODES.validation,
      { issues: validation.errors },
    );
  }
  const libraryById = new Map<string, ValidatedSkill>(
    validation.skills.map((skill) => [skill.id, skill]),
  );
  const statuses = await Promise.all(
    [...snapshot.lock.skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(
        async (skill) =>
          await assessResolvedSkill(snapshot.projectRoot, skill, libraryById.get(skill.id)),
      ),
  );
  return { libraryById, revision, snapshot, statuses };
}

async function withInspectedRevision<T>(
  options: ProjectInspectionOptions,
  request: LibraryRevisionRequest,
  consume: (inspection: RevisionInspection) => T | Promise<T>,
): Promise<T> {
  const snapshot = await readSnapshot(options.projectRoot);
  const revision = await options.library.resolve(request);
  try {
    return await consume(await inspectRevision(snapshot, revision));
  } finally {
    await revision.release?.();
  }
}

function inspectionRevisionRequest(options: ProjectInspectionOptions): LibraryRevisionRequest {
  if (options.offline === true && options.offlineRevision !== undefined) {
    throw reconciliationError(
      'CONFLICTING_OFFLINE_OPTIONS',
      'Cache-only inspection cannot be combined with an exact offline revision.',
      EXIT_CODES.usage,
    );
  }
  return {
    ...(options.offline === true
      ? { cacheOnly: true }
      : { allowStale: options.allowStale ?? true }),
    ...(options.offlineRevision === undefined ? {} : { offlineRevision: options.offlineRevision }),
    purpose: 'inspection',
  };
}

export async function inspectProjectStatus(
  options: ProjectInspectionOptions,
): Promise<ProjectStatusReport> {
  return await withInspectedRevision(
    options,
    inspectionRevisionRequest(options),
    ({ revision, snapshot, statuses }) => ({
      authoritative: !revision.stale,
      branch: revision.branch,
      freshness: revision.freshness,
      libraryIdentity: revision.identity,
      libraryRevision: revision.revision,
      operation: 'status',
      projectRoot: snapshot.projectRoot,
      refreshedAt: revision.refreshedAt,
      skills: statuses,
      stale: revision.stale,
      ...(revision.warning === undefined ? {} : { warning: revision.warning }),
    }),
  );
}

function compareInventories(
  libraryFiles: readonly RegularFileInventoryEntry[],
  localFiles: readonly RegularFileInventoryEntry[],
): readonly FileDifference[] {
  const libraryByPath = new Map(libraryFiles.map((file) => [file.relativePath, file]));
  const localByPath = new Map(localFiles.map((file) => [file.relativePath, file]));
  const paths = [...new Set([...libraryByPath.keys(), ...localByPath.keys()])].sort();
  return paths.flatMap((path): readonly FileDifference[] => {
    const libraryFile = libraryByPath.get(path);
    const localFile = localByPath.get(path);
    if (libraryFile === undefined && localFile !== undefined) {
      return [{ kind: 'local-only', localSha256: localFile.sha256, path }];
    }
    if (libraryFile !== undefined && localFile === undefined) {
      return [{ kind: 'library-only', librarySha256: libraryFile.sha256, path }];
    }
    if (
      libraryFile !== undefined &&
      localFile !== undefined &&
      libraryFile.sha256 !== localFile.sha256
    ) {
      return [
        {
          kind: 'different',
          librarySha256: libraryFile.sha256,
          localSha256: localFile.sha256,
          path,
        },
      ];
    }
    return [];
  });
}

export async function inspectProjectDiff(options: ProjectDiffOptions): Promise<ProjectDiffReport> {
  return await withInspectedRevision(
    options,
    inspectionRevisionRequest(options),
    ({ libraryById, revision, snapshot, statuses }) => {
      const resolution = resolveSkillSelectors(snapshot.lock.skills, [options.selector]);
      if (!resolution.success) {
        throw reconciliationError(
          'INVALID_SKILL_SELECTION',
          resolution.errors.map((error) => error.message).join('\n'),
          EXIT_CODES.validation,
          { errors: resolution.errors },
        );
      }
      const selected = resolution.values[0];
      if (selected === undefined) {
        throw reconciliationError(
          'MISSING_SKILL_SELECTION',
          'A tracked skill selector is required.',
          EXIT_CODES.usage,
        );
      }
      const status = statuses.find((candidate) => candidate.id === selected.id);
      if (status === undefined) {
        throw reconciliationError(
          'INCOMPLETE_PROJECT_STATE',
          `No status was produced for tracked skill ${selected.id}.`,
          EXIT_CODES.validation,
        );
      }
      const librarySkill = libraryById.get(selected.id);
      const libraryFiles = librarySkill?.files ?? [];
      const targets = status.destinations.map((destination): TargetDifference => ({
        destination: destination.path,
        differences:
          destination.inspectionError === undefined
            ? compareInventories(libraryFiles, destination.inventory)
            : [
                {
                  kind: 'unreadable',
                  path: '.',
                },
              ],
        ...(destination.digest === undefined ? {} : { digest: destination.digest }),
        divergentFromOtherTargets: status.assessment.divergentTargets.includes(destination.target),
        exists: destination.exists,
        target: destination.target,
      }));

      return {
        authoritative: !revision.stale,
        baseDigest: status.baseDigest,
        branch: revision.branch,
        canonicalDigestRecorded: status.canonicalDigestRecorded,
        freshness: revision.freshness,
        id: status.id,
        ...(status.libraryDigest === undefined ? {} : { libraryDigest: status.libraryDigest }),
        libraryIdentity: revision.identity,
        libraryRevision: revision.revision,
        operation: 'diff',
        projectRoot: snapshot.projectRoot,
        stale: revision.stale,
        state: status.state,
        targets,
        ...(revision.warning === undefined ? {} : { warning: revision.warning }),
      };
    },
  );
}

export interface ProjectHumanFormatOptions {
  readonly explicitProject?: boolean;
}

function projectOptionSuffix(options: ProjectHumanFormatOptions): string {
  return options.explicitProject === true ? ' --project <project-path>' : '';
}

export function formatProjectStatusHuman(
  report: ProjectStatusReport,
  options: ProjectHumanFormatOptions = {},
): string {
  const scopeOption = projectOptionSuffix(options);
  const freshness = report.authoritative ? report.freshness : `${report.freshness}, not current`;
  const ordered = [...report.skills].sort((left, right) =>
    comparePortableStrings(left.id, right.id),
  );
  const visible = ordered.slice(0, 20);
  const counts = new Map<string, number>();
  for (const skill of ordered) counts.set(skill.state, (counts.get(skill.state) ?? 0) + 1);
  const lines = [
    'Scope: project',
    `Project: ${report.projectRoot}`,
    `Library: ${report.libraryIdentity} @ ${report.libraryRevision} (${freshness})`,
    `Managed skills: ${String(ordered.length)}${
      counts.size === 0
        ? ''
        : ` (${[...counts.entries()]
            .sort(([left], [right]) => comparePortableStrings(left, right))
            .map(([state, count]) => `${state} ${String(count)}`)
            .join(', ')})`
    }`,
  ];
  if (report.warning !== undefined) lines.push(`Warning: ${report.warning.message}`);
  else if (report.stale) lines.push('Warning: Cached status may differ from the remote library.');
  if (ordered.length === 0) lines.push('No managed skills.');
  for (const skill of visible) {
    lines.push(`${skill.id}: ${skill.state}`);
    for (const destination of skill.destinations) {
      const detail = destination.exists
        ? destination.digest === undefined
          ? 'unreadable'
          : 'present'
        : 'missing';
      lines.push(`  ${destination.target} ${destination.path}: ${detail}`);
    }
  }
  if (visible.length < ordered.length) {
    lines.push(`… ${String(ordered.length - visible.length)} more managed skills omitted`);
  }
  const review = ordered.find((skill) =>
    ['conflicted', 'locally-modified', 'unmanaged-collision'].includes(skill.state),
  );
  const orphaned = ordered.find((skill) => skill.state === 'orphaned');
  const reconcile = ordered.find((skill) => ['missing', 'outdated'].includes(skill.state));
  lines.push(
    report.stale
      ? `Next: Re-run skill-sync status${scopeOption} without --offline before making changes.`
      : review !== undefined
        ? `Next: Review ${review.id} with skill-sync diff ${review.id}${scopeOption} before deciding whether to sync.`
        : orphaned !== undefined
          ? `Next: ${orphaned.id} no longer exists in the canonical library. Preview removal with skill-sync uninstall ${orphaned.id}${scopeOption} --dry-run, or restore that skill to the library.`
          : reconcile !== undefined
            ? `Next: Run skill-sync sync${scopeOption} to update or restore the non-current skills.`
            : ordered[0] === undefined
              ? `Next: Run skill-sync list${scopeOption} and follow its preview-ready install command.`
              : `Next: Inspect ${ordered[0].id} with skill-sync diff ${ordered[0].id}${scopeOption}, or run skill-sync list${scopeOption} to install more skills.`,
  );
  return lines.join('\n');
}

export function formatProjectDiffHuman(
  report: ProjectDiffReport,
  options: ProjectHumanFormatOptions = {},
): string {
  const scopeOption = projectOptionSuffix(options);
  const freshness = report.authoritative ? report.freshness : `${report.freshness}, not current`;
  const targets = [...report.targets].sort((left, right) => {
    const targetOrder = comparePortableStrings(left.target, right.target);
    return targetOrder === 0
      ? comparePortableStrings(left.destination, right.destination)
      : targetOrder;
  });
  const differenceCount = targets.reduce((total, target) => total + target.differences.length, 0);
  const lines = [
    `Scope: project (${report.projectRoot})`,
    `Skill: ${report.id}`,
    `State: ${report.state}`,
    `Library: ${report.libraryIdentity} @ ${report.libraryRevision} (${freshness})`,
    `Targets: ${String(targets.length)}; differences: ${String(differenceCount)}`,
  ];
  if (report.warning !== undefined) lines.push(`Warning: ${report.warning.message}`);
  else if (report.stale)
    lines.push('Warning: Cached differences may not reflect the remote library.');
  for (const target of targets) {
    const differences = [...target.differences].sort((left, right) => {
      const pathOrder = comparePortableStrings(left.path, right.path);
      return pathOrder === 0 ? comparePortableStrings(left.kind, right.kind) : pathOrder;
    });
    const visible = differences.slice(0, 25);
    lines.push(`${target.target} ${target.destination} (${String(differences.length)}):`);
    if (target.differences.length === 0) {
      lines.push('  no content differences');
    } else {
      for (const difference of visible) {
        lines.push(`  ${difference.kind}: ${difference.path}`);
      }
      if (visible.length < differences.length) {
        lines.push(`  … ${String(differences.length - visible.length)} more differences omitted`);
      }
    }
  }
  lines.push(
    report.stale
      ? `Next: Re-run skill-sync diff ${report.id}${scopeOption} when remote access is available before making changes.`
      : report.state === 'orphaned'
        ? `Next: ${report.id} no longer exists in the canonical library. Preview removal with skill-sync uninstall ${report.id}${scopeOption} --dry-run, or restore that skill to the library.`
        : differenceCount === 0
          ? `Next: No sync is needed; run skill-sync status${scopeOption} to review all managed skills.`
          : ['conflicted', 'locally-modified', 'unmanaged-collision'].includes(report.state)
            ? `Next: Keep the local edits, or run skill-sync sync${scopeOption} --discard-local only if canonical content should replace them.`
            : `Next: Run skill-sync sync${scopeOption} to reconcile this skill, then verify with skill-sync status${scopeOption}.`,
  );
  return lines.join('\n');
}

export type ReconciliationOperation = 'sync' | 'update';
export type ReconciliationAction =
  | 'none'
  | 'update'
  | 'restore'
  | 'discard-local'
  | 'skip-local'
  | 'skip-conflict'
  | 'skip-orphaned'
  | 'skip-collision';
export type ReconciliationOutcome =
  'unchanged' | 'planned' | 'updated' | 'restored' | 'discarded-local' | 'skipped' | 'failed';

export interface ReconciliationSkillResult extends ProjectSkillStatus {
  readonly action: ReconciliationAction;
  readonly backupPaths: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
  readonly outcome: ReconciliationOutcome;
  readonly writes: readonly string[];
}

export interface ProjectReconciliationReport {
  readonly applied: boolean;
  readonly authoritative: boolean;
  readonly branch: string;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly exitCode: ExitCode;
  readonly freshness: LibraryCacheFreshness;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operation: ReconciliationOperation;
  readonly projectRoot: string;
  readonly selectedIds: readonly string[];
  readonly skills: readonly ReconciliationSkillResult[];
  readonly stale: boolean;
  readonly warning?: { readonly code: string; readonly message: string };
  readonly wouldChange: boolean;
}

export interface ReconciliationTransactionHooks {
  beforeCommit?(context: {
    readonly index: number;
    readonly skillId: string;
  }): Promise<void> | void;
}

interface CommonReconciliationOptions {
  readonly check?: boolean;
  readonly confirmed?: boolean;
  readonly discardLocal?: boolean;
  readonly dryRun?: boolean;
  readonly hooks?: ReconciliationTransactionHooks;
  readonly library: LibraryRevisionProvider;
  readonly offlineRevision?: string;
  readonly operationId?: string;
  readonly operationGuard?: OperationGuard;
  readonly projectRoot: string;
  readonly storage?: ProjectMutationStorage;
}

export type SyncProjectSkillsOptions = CommonReconciliationOptions;

export interface UpdateProjectSkillsOptions extends CommonReconciliationOptions {
  readonly all?: boolean;
  readonly selectors?: readonly string[];
}

interface ReconciliationPlan {
  readonly inspection: RevisionInspection;
  readonly results: readonly ReconciliationSkillResult[];
  readonly selectedIds: readonly string[];
}

function selectStatuses(
  operation: ReconciliationOperation,
  inspection: RevisionInspection,
  selectors: readonly string[] | undefined,
  all: boolean,
): readonly ProjectSkillStatus[] {
  if (operation === 'sync' || all) {
    if (operation === 'update' && (selectors?.length ?? 0) > 0) {
      throw reconciliationError(
        'CONFLICTING_SELECTION',
        'update --all cannot be combined with explicit skill selectors.',
        EXIT_CODES.usage,
      );
    }
    const selected = selectAllSkills(inspection.statuses);
    if (!selected.success) {
      throw reconciliationError(
        'INVALID_SKILL_SELECTION',
        selected.errors.map((error) => error.message).join('\n'),
        EXIT_CODES.validation,
        { errors: selected.errors },
      );
    }
    return selected.values;
  }

  if (selectors === undefined || selectors.length === 0) {
    throw reconciliationError(
      'MISSING_SKILL_SELECTION',
      'update requires explicit tracked skill selectors or --all after interactive selection.',
      EXIT_CODES.usage,
    );
  }
  const selected = resolveSkillSelectors(inspection.statuses, selectors);
  if (!selected.success) {
    throw reconciliationError(
      'INVALID_SKILL_SELECTION',
      selected.errors.map((error) => error.message).join('\n'),
      EXIT_CODES.validation,
      { errors: selected.errors },
    );
  }
  return selected.values;
}

function actionForStatus(status: ProjectSkillStatus, discardLocal: boolean): ReconciliationAction {
  switch (status.state) {
    case 'current':
      return 'none';
    case 'outdated':
      return 'update';
    case 'missing':
      return 'restore';
    case 'locally-modified':
      return discardLocal ? 'discard-local' : 'skip-local';
    case 'conflicted':
      return discardLocal ? 'discard-local' : 'skip-conflict';
    case 'orphaned':
      return 'skip-orphaned';
    case 'unmanaged-collision':
      return 'skip-collision';
  }
}

function plannedOutcome(action: ReconciliationAction): ReconciliationOutcome {
  if (action === 'none') return 'unchanged';
  if (action.startsWith('skip-')) return 'skipped';
  return 'planned';
}

function backupPathsFor(
  status: ProjectSkillStatus,
  action: ReconciliationAction,
): readonly string[] {
  if (action !== 'discard-local') return [];
  return [
    ...status.destinations
      .filter((destination) => destination.exists)
      .map((destination) => destination.path),
    PROJECT_MANIFEST_FILENAME,
    PROJECT_LOCK_FILENAME,
  ].sort();
}

function writesFor(status: ProjectSkillStatus, action: ReconciliationAction): readonly string[] {
  if (!['update', 'restore', 'discard-local'].includes(action)) return [];
  return [
    ...status.destinations.map((destination) => destination.path),
    PROJECT_LOCK_FILENAME,
  ].sort();
}

function buildPlan(
  operation: ReconciliationOperation,
  inspection: RevisionInspection,
  options: {
    readonly all: boolean;
    readonly discardLocal: boolean;
    readonly selectors?: readonly string[];
  },
): ReconciliationPlan {
  const selected = selectStatuses(operation, inspection, options.selectors, options.all);
  const results = selected.map((status): ReconciliationSkillResult => {
    const action = actionForStatus(status, options.discardLocal);
    return {
      ...status,
      action,
      backupPaths: backupPathsFor(status, action),
      outcome: plannedOutcome(action),
      writes: writesFor(status, action),
    };
  });
  return { inspection, results, selectedIds: selected.map((status) => status.id) };
}

function requireMutationRevision(
  revision: ResolvedLibraryRevision,
  offlineRevision: string | undefined,
): void {
  if (!revision.usableForMutation) {
    throw reconciliationError(
      'FRESH_LIBRARY_REVISION_REQUIRED',
      'Reconciliation mutation requires a successful fetch or an explicitly requested cached revision.',
      EXIT_CODES.repository,
    );
  }
  if (revision.stale && revision.freshness !== 'offline-revision') {
    throw reconciliationError(
      'FRESH_LIBRARY_REVISION_REQUIRED',
      'Stale fallback data may be inspected but cannot be applied.',
      EXIT_CODES.repository,
    );
  }
  if (revision.freshness === 'offline-revision' && offlineRevision === undefined) {
    throw reconciliationError(
      'EXPLICIT_OFFLINE_REVISION_REQUIRED',
      'Applying a cached revision requires an explicit exact offline revision.',
      EXIT_CODES.repository,
    );
  }
}

function boundedOperationId(value: string, maximumLength = 120): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/gu, '-');
  const nonempty = normalized.length === 0 ? 'skill' : normalized;
  if (nonempty.length <= maximumLength) return nonempty;
  const suffix = createHash('sha256').update(nonempty).digest('hex').slice(0, 16);
  return `${nonempty.slice(0, maximumLength - suffix.length - 1)}-${suffix}`;
}

async function writeStagedLock(path: string, lock: ProjectLock): Promise<void> {
  await writeFile(path, stableJsonStringify(lock), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
}

function nextLockForSkill(
  current: ProjectLock,
  revision: string,
  status: ProjectSkillStatus,
): ProjectLock {
  const libraryDigest = status.libraryDigest;
  if (libraryDigest === undefined) {
    throw new Error(`Cannot reconcile orphaned skill ${status.id}.`);
  }
  return canonicalizeProjectLock({
    ...current,
    library: { ...current.library, revision },
    skills: current.skills.map((skill) =>
      skill.id === status.id
        ? {
            baseDigest: libraryDigest,
            canonicalDigest: libraryDigest,
            id: skill.id,
            projections: skill.projections.map((projection) => ({
              ...projection,
              digest: libraryDigest,
            })),
          }
        : skill,
    ),
  });
}

function requireStorage(storage: ProjectMutationStorage | undefined): ProjectMutationStorage {
  if (storage === undefined) {
    throw reconciliationError(
      'MISSING_TRANSACTION_STORAGE',
      'Applying reconciliation requires lock, journal, staging, and backup storage paths.',
      EXIT_CODES.usage,
    );
  }
  return storage;
}

async function applySkill(
  plan: ReconciliationSkillResult,
  inspection: RevisionInspection,
  currentLock: ProjectLock,
  options: {
    readonly hooks?: ReconciliationTransactionHooks;
    readonly operationId: string;
    readonly operationGuard?: OperationGuard;
    readonly storage: ProjectMutationStorage;
  },
): Promise<ProjectLock> {
  const librarySkill = inspection.libraryById.get(plan.id);
  if (librarySkill === undefined) throw new Error(`Library skill ${plan.id} is unavailable.`);

  if (plan.backupPaths.length > 0) {
    await createRecoverableBackup({
      backupRoot: options.storage.backupRoot,
      entries: plan.backupPaths.map((relativePath) => ({
        path: join(inspection.snapshot.projectRoot, ...relativePath.split('/')),
        relativePath,
      })),
      operationId: boundedOperationId(`${options.operationId}-backup`, 128),
      projectRoot: inspection.snapshot.projectRoot,
    });
  }

  const staging = await createStagingDirectory(options.storage.stagingRoot, options.operationId);
  try {
    const stagedSkill = await stageRegularPath(librarySkill.rootPath, staging, 'canonical');
    const stagedTree = await inspectRegularFileTree(stagedSkill, { rejectNestedSkillRoots: true });
    if (stagedTree.digest !== librarySkill.digest) {
      throw new Error(`Staged canonical bytes for ${plan.id} failed digest verification.`);
    }
    const nextLock = nextLockForSkill(currentLock, inspection.revision.revision, plan);
    const stagedLock = join(staging, PROJECT_LOCK_FILENAME);
    await writeStagedLock(stagedLock, nextLock);

    const replacements: AtomicReplacement[] = plan.destinations.map((destination) => ({
      action: 'replace',
      destinationPath: join(inspection.snapshot.projectRoot, ...destination.path.split('/')),
      stagedPath: stagedSkill,
    }));
    replacements.push({
      action: 'replace',
      destinationPath: join(inspection.snapshot.projectRoot, PROJECT_LOCK_FILENAME),
      stagedPath: stagedLock,
    });
    await replacePathsAtomically({
      ...(options.hooks?.beforeCommit === undefined
        ? {}
        : {
            hooks: {
              beforeCommit: async (index: number) =>
                await options.hooks?.beforeCommit?.({ index, skillId: plan.id }),
            },
          }),
      journalDirectory: options.storage.journalDirectory,
      kind: 'reconcile',
      operationId: options.operationId,
      ...(options.operationGuard === undefined ? {} : { operationGuard: options.operationGuard }),
      replacements,
      root: inspection.snapshot.projectRoot,
    });
    return nextLock;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function successfulOutcome(action: ReconciliationAction): ReconciliationOutcome {
  if (action === 'restore') return 'restored';
  if (action === 'discard-local') return 'discarded-local';
  return 'updated';
}

function reportExitCode(
  results: readonly ReconciliationSkillResult[],
  options: { readonly check: boolean; readonly dryRun: boolean; readonly stale: boolean },
): ExitCode {
  if (options.check) {
    if (options.stale) return EXIT_CODES.repository;
    return results.some((result) => result.state !== 'current')
      ? EXIT_CODES.conflict
      : EXIT_CODES.success;
  }

  const failures = results.filter((result) => result.outcome === 'failed');
  const skipped = results.filter((result) => result.outcome === 'skipped');
  const applied = results.filter((result) =>
    ['updated', 'restored', 'discarded-local'].includes(result.outcome),
  );
  if (options.dryRun) {
    return skipped.length > 0 ? EXIT_CODES.conflict : EXIT_CODES.success;
  }
  if (failures.length > 0 || skipped.length > 0) {
    if (applied.length > 0) return EXIT_CODES.partial;
    return failures.length > 0 ? EXIT_CODES.internal : EXIT_CODES.conflict;
  }
  return EXIT_CODES.success;
}

function finalizeReport(
  operation: ReconciliationOperation,
  plan: ReconciliationPlan,
  results: readonly ReconciliationSkillResult[],
  options: { readonly check: boolean; readonly dryRun: boolean },
): ProjectReconciliationReport {
  const revision = plan.inspection.revision;
  const applied = results.some((result) =>
    ['updated', 'restored', 'discarded-local'].includes(result.outcome),
  );
  return {
    applied,
    authoritative: !revision.stale,
    branch: revision.branch,
    check: options.check,
    dryRun: options.dryRun,
    exitCode: reportExitCode(results, {
      check: options.check,
      dryRun: options.dryRun,
      stale: revision.stale,
    }),
    freshness: revision.freshness,
    libraryIdentity: revision.identity,
    libraryRevision: revision.revision,
    operation,
    projectRoot: plan.inspection.snapshot.projectRoot,
    selectedIds: plan.selectedIds,
    skills: results,
    stale: revision.stale,
    ...(revision.warning === undefined ? {} : { warning: revision.warning }),
    wouldChange: results.some((result) =>
      ['update', 'restore', 'discard-local'].includes(result.action),
    ),
  };
}

async function reconcile(
  operation: ReconciliationOperation,
  options: CommonReconciliationOptions & {
    readonly all: boolean;
    readonly selectors?: readonly string[];
  },
): Promise<ProjectReconciliationReport> {
  const snapshot = await readSnapshot(options.projectRoot);
  const revision = await options.library.resolve({
    ...(options.offlineRevision === undefined ? {} : { offlineRevision: options.offlineRevision }),
    purpose: 'application',
  });
  try {
    requireMutationRevision(revision, options.offlineRevision);
    let inspection = await inspectRevision(snapshot, revision);
    let plan = buildPlan(operation, inspection, {
      all: options.all,
      discardLocal: options.discardLocal === true,
      ...(options.selectors === undefined ? {} : { selectors: options.selectors }),
    });
    const check = options.check === true;
    const dryRun = options.dryRun === true || check;
    const destructive = plan.results.filter((result) => result.action === 'discard-local');
    if (destructive.length > 0 && !dryRun && options.confirmed !== true) {
      throw reconciliationError(
        'DESTRUCTIVE_CONFIRMATION_REQUIRED',
        'Discarding local skill changes requires explicit confirmation after preview.',
        EXIT_CODES.usage,
        { ids: destructive.map((result) => result.id) },
      );
    }
    if (dryRun || !plan.results.some((result) => result.writes.length > 0)) {
      return finalizeReport(operation, plan, plan.results, { check, dryRun });
    }

    const storage = requireStorage(options.storage);
    const operationId = boundedOperationId(options.operationId ?? `${operation}-${randomUUID()}`);
    const lock = await acquireAdvisoryLock(storage.lockPath, { operationId });
    try {
      // Re-read and reclassify under the project lock to close the preview/write race.
      inspection = await inspectRevision(await readSnapshot(options.projectRoot), revision);
      plan = buildPlan(operation, inspection, {
        all: options.all,
        discardLocal: options.discardLocal === true,
        ...(options.selectors === undefined ? {} : { selectors: options.selectors }),
      });
      const lockedDestructive = plan.results.filter((result) => result.action === 'discard-local');
      if (lockedDestructive.length > 0 && options.confirmed !== true) {
        throw reconciliationError(
          'DESTRUCTIVE_CONFIRMATION_REQUIRED',
          'Project content changed before application; destructive confirmation is required.',
          EXIT_CODES.usage,
          { ids: lockedDestructive.map((result) => result.id) },
        );
      }

      let currentLock = inspection.snapshot.lock;
      const results: ReconciliationSkillResult[] = [];
      for (const [index, result] of plan.results.entries()) {
        if (!['update', 'restore', 'discard-local'].includes(result.action)) {
          results.push(result);
          continue;
        }
        const skillOperationId = boundedOperationId(
          `${operationId}-${String(index + 1)}-${result.id}`,
        );
        try {
          currentLock = await applySkill(result, inspection, currentLock, {
            ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
            operationId: skillOperationId,
            ...(options.operationGuard === undefined
              ? {}
              : { operationGuard: options.operationGuard }),
            storage,
          });
          results.push({ ...result, outcome: successfulOutcome(result.action) });
        } catch (error) {
          if (isRecoveryIntegrityError(error) || !isTransactionRolledBackError(error)) {
            throw error;
          }
          results.push({
            ...result,
            error: { code: 'SKILL_RECONCILIATION_FAILED', message: safeMessage(error) },
            outcome: 'failed',
          });
        }
      }
      return finalizeReport(operation, plan, results, { check: false, dryRun: false });
    } finally {
      await lock.release();
    }
  } finally {
    await revision.release?.();
  }
}

export async function syncProjectSkills(
  options: SyncProjectSkillsOptions,
): Promise<ProjectReconciliationReport> {
  return await reconcile('sync', { ...options, all: true });
}

export async function updateProjectSkills(
  options: UpdateProjectSkillsOptions,
): Promise<ProjectReconciliationReport> {
  return await reconcile('update', {
    ...options,
    all: options.all === true,
    ...(options.selectors === undefined ? {} : { selectors: options.selectors }),
  });
}

interface ReconciliationHumanReport {
  readonly applied: boolean;
  readonly authoritative: boolean;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly freshness: string;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operation: ReconciliationOperation;
  readonly selectedIds: readonly string[];
  readonly skills: readonly ReconciliationSkillResult[];
  readonly stale: boolean;
  readonly warning?: { readonly code: string; readonly message: string };
  readonly wouldChange: boolean;
}

interface ReconciliationHumanScope {
  readonly label: string;
  readonly optionSuffix: string;
}

const RECONCILIATION_HUMAN_LIMIT = 20;
const RECONCILIATION_OUTCOME_ORDER: readonly ReconciliationOutcome[] = [
  'unchanged',
  'planned',
  'updated',
  'restored',
  'discarded-local',
  'skipped',
  'failed',
];

function reconciliationResultLabel(report: ReconciliationHumanReport): string {
  const failed = report.skills.some((skill) => skill.outcome === 'failed');
  const skipped = report.skills.some((skill) => skill.outcome === 'skipped');
  if (failed || skipped) return report.applied ? 'partial' : 'needs attention';
  if (report.check) return report.wouldChange ? 'changes detected' : 'current';
  if (report.dryRun) return report.wouldChange ? 'changes planned' : 'no changes';
  return report.applied ? 'complete' : 'already current';
}

function reconciliationCommand(
  report: ReconciliationHumanReport,
  optionSuffix: ReconciliationHumanScope['optionSuffix'],
): string | undefined {
  if (report.operation === 'sync') return `skill-sync sync${optionSuffix}`;
  if (report.selectedIds.length === 0) return `skill-sync update --all${optionSuffix}`;
  if (report.selectedIds.length > 5) return undefined;
  return `skill-sync update ${report.selectedIds.join(' ')}${optionSuffix}`;
}

function countLabel(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

function reconciliationNextAction(
  report: ReconciliationHumanReport,
  scope: ReconciliationHumanScope,
): string {
  const statusCommand = `skill-sync status${scope.optionSuffix}`;
  const command = reconciliationCommand(report, scope.optionSuffix);
  const failed = report.skills.find((skill) => skill.outcome === 'failed');
  if (failed !== undefined) {
    const retry =
      command === undefined ? 'retry the same skill-sync update selection' : `retry ${command}`;
    return `Next: Fix the failure for ${failed.id}, then ${retry}; run skill-sync doctor if the cause is environmental.`;
  }
  const orphaned = report.skills.find((skill) => skill.action === 'skip-orphaned');
  if (orphaned !== undefined) {
    return `Next: ${orphaned.id} no longer exists in the canonical library. Preview removal with skill-sync uninstall ${orphaned.id}${scope.optionSuffix} --dry-run, or restore that skill to the library.`;
  }
  const skipped = report.skills.find((skill) => skill.outcome === 'skipped');
  if (skipped !== undefined) {
    const retry =
      command === undefined ? 'retry the same skill-sync update selection' : `retry ${command}`;
    return `Next: Review ${skipped.id} with skill-sync diff ${skipped.id}${scope.optionSuffix}, resolve the reported conflict, then ${retry}.`;
  }
  if (report.stale) {
    return `Next: Run ${statusCommand} when remote access is available to confirm the current remote state.`;
  }
  if ((report.check || report.dryRun) && report.wouldChange) {
    const destructive = report.skills.some((skill) => skill.action === 'discard-local');
    if (command === undefined) {
      return 'Next: Re-run the same skill-sync update selection without --dry-run to apply this preview.';
    }
    return `Next: Apply with ${command}${destructive ? ' --discard-local' : ''}, then verify with ${statusCommand}.`;
  }
  if (report.applied) return `Next: Verify with ${statusCommand}.`;
  return `Next: No changes needed; run ${statusCommand} to review all managed skills.`;
}

export function formatReconciliationReportHuman(
  report: ReconciliationHumanReport,
  scope: ReconciliationHumanScope,
): string {
  const mode = report.check ? 'check' : report.dryRun ? 'dry-run' : 'apply';
  const freshness = report.authoritative ? report.freshness : `${report.freshness}, not current`;
  const outcomeCounts = new Map<ReconciliationOutcome, number>();
  for (const skill of report.skills) {
    outcomeCounts.set(skill.outcome, (outcomeCounts.get(skill.outcome) ?? 0) + 1);
  }
  const outcomes = RECONCILIATION_OUTCOME_ORDER.flatMap((outcome) => {
    const count = outcomeCounts.get(outcome) ?? 0;
    return count === 0 ? [] : [`${outcome} ${String(count)}`];
  });
  const writeCount = new Set(report.skills.flatMap((skill) => skill.writes)).size;
  const backupCount = new Set(report.skills.flatMap((skill) => skill.backupPaths)).size;
  const sortedSkills = [...report.skills].sort((left, right) =>
    comparePortableStrings(left.id, right.id),
  );
  const visibleSkills = sortedSkills.slice(0, RECONCILIATION_HUMAN_LIMIT);
  const lines = [
    `${report.operation === 'sync' ? 'Sync' : 'Update'} ${mode}: ${scope.label}`,
    `Library: ${report.libraryIdentity} @ ${report.libraryRevision} (${freshness})`,
    `Result: ${reconciliationResultLabel(report)}; selected ${String(report.skills.length)}`,
    `Outcomes: ${outcomes.length === 0 ? 'none' : outcomes.join('; ')}`,
  ];
  if (writeCount > 0 || backupCount > 0) {
    lines.push(`Paths: ${countLabel(writeCount, 'write')}; ${countLabel(backupCount, 'backup')}`);
  }
  if (report.warning !== undefined) lines.push(`Warning: ${report.warning.message}`);
  if (visibleSkills.length === 0) {
    lines.push('Skills: none');
  } else {
    lines.push(
      `Skills (showing ${String(visibleSkills.length)} of ${String(sortedSkills.length)}):`,
    );
  }
  for (const skill of visibleSkills) {
    const details = [
      ...(skill.action === 'none' ? [] : [skill.action]),
      ...(skill.writes.length === 0 ? [] : [countLabel(skill.writes.length, 'write')]),
      ...(skill.backupPaths.length === 0 ? [] : [countLabel(skill.backupPaths.length, 'backup')]),
    ];
    lines.push(
      `  ${skill.id}: ${skill.state} → ${skill.outcome}${details.length === 0 ? '' : ` (${details.join('; ')})`}`,
    );
    if (skill.error !== undefined) {
      lines.push(`    Error ${skill.error.code}: ${skill.error.message}`);
    }
  }
  if (visibleSkills.length < sortedSkills.length) {
    lines.push(`  … ${String(sortedSkills.length - visibleSkills.length)} more skills omitted`);
  }
  lines.push(reconciliationNextAction(report, scope));
  return lines.join('\n');
}

export function formatProjectReconciliationHuman(
  report: ProjectReconciliationReport,
  options: ProjectHumanFormatOptions = {},
): string {
  return formatReconciliationReportHuman(report, {
    label: `project ${report.projectRoot}`,
    optionSuffix: projectOptionSuffix(options),
  });
}
