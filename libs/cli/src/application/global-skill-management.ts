import { randomUUID } from 'node:crypto';
import { lstat, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import type { CatalogSkillRecord } from './catalog.js';
import type { ProjectMutationStorage } from './project-installation.js';
import {
  type LibraryRevisionProvider,
  type ProjectDiffReport,
  type ProjectSkillStatus,
  type ProjectStatusReport,
  type ReconciliationAction,
  type ReconciliationSkillResult,
  type ReconciliationTransactionHooks,
  type ResolvedLibraryRevision,
} from './project-reconciliation.js';
import { resolveSkillSelectors, selectAllSkills } from './selectors.js';
import { inspectRegularFileTree, type RegularFileInventoryEntry } from '../domain/digest.js';
import { validateLibrary, validateSkillDirectory, type ValidatedSkill } from '../domain/library.js';
import {
  PROJECT_LOCK_SCHEMA_VERSION,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  canonicalizeProjectLock,
  canonicalizeProjectManifest,
  projectLockSchema,
  projectManifestSchema,
  type ProjectLock,
  type ProjectManifest,
  type ResolvedSkill,
} from '../domain/project-state.js';
import { classifyReconciliation, type ReconciliationState } from '../domain/reconciliation.js';
import { EXIT_CODES, SkillSyncError, redactSecrets, type ExitCode } from '../domain/result.js';
import type { ApplicationPaths } from '../infrastructure/config.js';
import {
  readGlobalLock,
  readGlobalManifest,
  GLOBAL_LOCK_FILENAME,
  GLOBAL_MANIFEST_FILENAME,
} from '../infrastructure/global-state.js';
import { assertProjectStatePair, isPathContained } from '../infrastructure/project-state.js';
import { stableJsonStringify } from '../infrastructure/stable-json.js';
import {
  acquireAdvisoryLock,
  createRecoverableBackup,
  createStagingDirectory,
  replacePathsAtomically,
  stageRegularPath,
  type AtomicReplacement,
} from '../infrastructure/transactions.js';
import {
  resolveContainedGlobalDestination,
  TargetRegistry,
  type TargetAdapter,
  type TargetName,
} from '../targets/index.js';

type ResolvedInstallSkill = Pick<CatalogSkillRecord, 'digest' | 'id' | 'name' | 'rootPath'>;

export interface GlobalInstallPlan {
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly libraryRevision: string;
  readonly operation: 'install';
  readonly scope: 'global';
  readonly stateDirectory: string;
  readonly skills: readonly {
    readonly digest: string;
    readonly id: string;
    readonly projections: readonly {
      readonly destination: string;
      readonly target: string;
      readonly write: boolean;
    }[];
    readonly status: 'install' | 'expand-targets' | 'already-installed';
  }[];
  readonly state: { readonly lockChanged: boolean; readonly manifestChanged: boolean };
  readonly writes: readonly string[];
}

export interface GlobalUninstallPlan {
  readonly applied: boolean;
  readonly backup: { readonly paths: readonly string[]; readonly required: boolean };
  readonly dryRun: boolean;
  readonly libraryRevision: string;
  readonly operation: 'uninstall';
  readonly scope: 'global';
  readonly stateDirectory: string;
  readonly skills: readonly {
    readonly id: string;
    readonly locallyModified: boolean;
    readonly projections: readonly {
      readonly destination: string;
      readonly target: string;
      readonly write: boolean;
    }[];
  }[];
  readonly state: { readonly lockChanged: boolean; readonly manifestChanged: boolean };
  readonly writes: readonly string[];
}

export type ResolvedGlobalAdoptSkill = Pick<
  CatalogSkillRecord,
  'compatibleAgents' | 'digest' | 'id' | 'name' | 'rootPath'
>;

export interface AdoptGlobalSkillOptions {
  readonly dryRun?: boolean;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operationId?: string;
  readonly paths: ApplicationPaths;
  readonly registry?: TargetRegistry;
  readonly skill: ResolvedGlobalAdoptSkill;
  readonly storage?: ProjectMutationStorage;
  readonly target: TargetName;
}

export interface GlobalAdoptPlan {
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly libraryRevision: string;
  readonly operation: 'adopt';
  readonly scope: 'global';
  readonly skill: {
    readonly destination: string;
    readonly digest: string;
    readonly id: string;
    readonly target: string;
  };
  readonly state: { readonly lockChanged: boolean; readonly manifestChanged: boolean };
  readonly stateDirectory: string;
  readonly writes: readonly string[];
}

export interface GlobalStatusReport extends Omit<ProjectStatusReport, 'operation' | 'projectRoot'> {
  readonly operation: 'status';
  readonly scope: 'global';
  readonly stateDirectory: string;
}

export interface GlobalDiffReport extends Omit<ProjectDiffReport, 'operation' | 'projectRoot'> {
  readonly operation: 'diff';
  readonly scope: 'global';
  readonly stateDirectory: string;
}

export interface GlobalReconciliationReport {
  readonly applied: boolean;
  readonly authoritative: boolean;
  readonly branch: string;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly exitCode: ExitCode;
  readonly freshness: string;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operation: 'sync' | 'update';
  readonly scope: 'global';
  readonly selectedIds: readonly string[];
  readonly skills: readonly ReconciliationSkillResult[];
  readonly stale: boolean;
  readonly stateDirectory: string;
  readonly warning?: { readonly code: string; readonly message: string };
  readonly wouldChange: boolean;
}

interface GlobalSnapshot {
  readonly lock: ProjectLock;
  readonly manifest: ProjectManifest;
  readonly stateDirectory: string;
}

interface GlobalInspection {
  readonly libraryById: ReadonlyMap<string, ValidatedSkill>;
  readonly revision: ResolvedLibraryRevision;
  readonly snapshot: GlobalSnapshot;
  readonly statuses: readonly ProjectSkillStatus[];
}

function globalError(
  code: string,
  message: string,
  exitCode: ExitCode,
  details?: Readonly<Record<string, unknown>>,
): SkillSyncError {
  return new SkillSyncError(code, message, exitCode, details);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stateDirectory(paths: ApplicationPaths): string {
  if (paths.globalStateDirectory === undefined) {
    throw globalError(
      'GLOBAL_STATE_UNAVAILABLE',
      'Global skill state paths are unavailable.',
      EXIT_CODES.validation,
    );
  }
  return paths.globalStateDirectory;
}

function stateFiles(paths: ApplicationPaths): { readonly lock: string; readonly manifest: string } {
  if (paths.globalManifestFile === undefined || paths.globalLockFile === undefined) {
    throw globalError(
      'GLOBAL_STATE_UNAVAILABLE',
      'Global skill state paths are unavailable.',
      EXIT_CODES.validation,
    );
  }
  return { lock: paths.globalLockFile, manifest: paths.globalManifestFile };
}

function leafName(value: string): string {
  if (value.includes('/') || value.includes('\\') || value === '' || basename(value) !== value) {
    throw globalError(
      'INVALID_GLOBAL_DESTINATION',
      `Invalid global skill leaf name: ${value}`,
      EXIT_CODES.validation,
    );
  }
  return value;
}

function targetAdapter(registry: TargetRegistry, target: string): TargetAdapter {
  const adapter = registry.get(target);
  if (adapter === undefined) {
    throw globalError('UNKNOWN_TARGET', `Unknown target: ${target}`, EXIT_CODES.validation);
  }
  if (adapter.globalDestination === undefined || adapter.globalRoot === undefined) {
    throw globalError(
      'GLOBAL_TARGET_UNSUPPORTED',
      `Target ${target} does not support global skill installation.`,
      EXIT_CODES.validation,
    );
  }
  return adapter;
}

async function destinationFor(
  registry: TargetRegistry,
  target: string,
  destinationLeaf: string,
): Promise<string> {
  const adapter = targetAdapter(registry, target);
  const leaf = leafName(destinationLeaf);
  const globalRoot = adapter.globalRoot;
  const globalDestination = adapter.globalDestination;
  if (globalRoot === undefined || globalDestination === undefined) {
    throw globalError(
      'GLOBAL_TARGET_UNSUPPORTED',
      `Target ${target} does not support global skills.`,
      EXIT_CODES.validation,
    );
  }
  return await resolveContainedGlobalDestination(globalRoot(), globalDestination(leaf));
}

function commonRoot(paths: readonly string[]): string {
  const first = paths[0];
  if (first === undefined) throw new Error('A transaction requires at least one path.');
  let root = resolve(first);
  for (;;) {
    if (paths.every((path) => isPathContained(root, resolve(path)))) return root;
    const parent = dirname(root);
    if (parent === root) {
      throw globalError(
        'GLOBAL_PATHS_NOT_COLOCATED',
        'Global state and selected target destinations do not share a filesystem root.',
        EXIT_CODES.validation,
      );
    }
    root = parent;
  }
}

function relativeFrom(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  if (value === '' || value.startsWith('../') || value === '..') {
    throw new Error(`Path is not contained by its global transaction root: ${path}`);
  }
  return value;
}

async function readSnapshot(paths: ApplicationPaths): Promise<GlobalSnapshot> {
  const [manifest, lock] = await Promise.all([readGlobalManifest(paths), readGlobalLock(paths)]);
  if (manifest === undefined || lock === undefined) {
    throw globalError(
      'GLOBAL_STATE_REQUIRED',
      `Both ${GLOBAL_MANIFEST_FILENAME} and ${GLOBAL_LOCK_FILENAME} are required for global skill operations.`,
      EXIT_CODES.validation,
    );
  }
  if (manifest.library.identity !== lock.library.identity) {
    throw globalError(
      'INVALID_GLOBAL_STATE',
      'Global manifest and lock reference different libraries.',
      EXIT_CODES.validation,
    );
  }
  const desiredIds = manifest.skills.map((skill) => skill.id).sort();
  const lockedIds = lock.skills.map((skill) => skill.id).sort();
  if (desiredIds.join('\n') !== lockedIds.join('\n')) {
    throw globalError(
      'INVALID_GLOBAL_STATE',
      'Global manifest and lock must contain the same skill IDs.',
      EXIT_CODES.validation,
    );
  }
  return { lock, manifest, stateDirectory: stateDirectory(paths) };
}

async function readOptionalSnapshot(paths: ApplicationPaths): Promise<{
  readonly lock: ProjectLock | undefined;
  readonly manifest: ProjectManifest | undefined;
}> {
  const [manifest, lock] = await Promise.all([readGlobalManifest(paths), readGlobalLock(paths)]);
  if ((manifest === undefined) !== (lock === undefined)) {
    throw globalError(
      'INCOMPLETE_GLOBAL_STATE',
      `Both ${GLOBAL_MANIFEST_FILENAME} and ${GLOBAL_LOCK_FILENAME} must be present together.`,
      EXIT_CODES.validation,
    );
  }
  if (
    manifest !== undefined &&
    lock !== undefined &&
    manifest.library.identity !== lock.library.identity
  ) {
    throw globalError(
      'INVALID_GLOBAL_STATE',
      'Global manifest and lock reference different libraries.',
      EXIT_CODES.validation,
    );
  }
  if (manifest !== undefined && lock !== undefined) {
    try {
      assertProjectStatePair(manifest, lock);
    } catch (error) {
      throw globalError(
        'INVALID_GLOBAL_STATE',
        error instanceof Error ? error.message : 'Global manifest and lock state is invalid.',
        EXIT_CODES.validation,
      );
    }
    const manifestIds = manifest.skills.map((skill) => skill.id).sort();
    const lockIds = lock.skills.map((skill) => skill.id).sort();
    if (manifestIds.join('\n') !== lockIds.join('\n')) {
      throw globalError(
        'INVALID_GLOBAL_STATE',
        'Global manifest and lock must contain the same skill IDs.',
        EXIT_CODES.validation,
      );
    }
  }
  return { lock, manifest };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectDestination(
  registry: TargetRegistry,
  baseDigest: string,
  projection: ResolvedSkill['projections'][number],
): Promise<ProjectSkillStatus['destinations'][number]> {
  const destination = await destinationFor(registry, projection.target, projection.destination);
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        changedFromBase: false,
        changedFromRecorded: false,
        exists: false,
        inventory: [],
        path: destination,
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
      path: destination,
      recordedDigest: projection.digest,
      target: projection.target,
    };
  } catch (error) {
    return {
      changedFromBase: true,
      changedFromRecorded: true,
      digest: `invalid-tree:${destination}`,
      exists: true,
      inspectionError: redactSecrets(error instanceof Error ? error.message : String(error)),
      inventory: [],
      path: destination,
      recordedDigest: projection.digest,
      target: projection.target,
    };
  }
}

async function assessSkill(
  registry: TargetRegistry,
  resolved: ResolvedSkill,
  librarySkill: ValidatedSkill | undefined,
): Promise<ProjectSkillStatus> {
  const destinations = await Promise.all(
    [...resolved.projections]
      .sort((left, right) => left.target.localeCompare(right.target))
      .map(
        async (projection) => await inspectDestination(registry, resolved.baseDigest, projection),
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
  paths: ApplicationPaths,
  registry: TargetRegistry,
  revision: ResolvedLibraryRevision,
): Promise<GlobalInspection> {
  const snapshot = await readSnapshot(paths);
  if (snapshot.manifest.library.identity !== revision.identity) {
    throw globalError(
      'GLOBAL_LIBRARY_MISMATCH',
      `Global library ${snapshot.manifest.library.identity} does not match the resolved library ${revision.identity}.`,
      EXIT_CODES.validation,
    );
  }
  const validation = await validateLibrary(revision.libraryRoot);
  if (!validation.valid) {
    throw globalError(
      'INVALID_LIBRARY',
      'The selected library revision is invalid.',
      EXIT_CODES.validation,
      {
        issues: validation.errors,
      },
    );
  }
  const libraryById = new Map<string, ValidatedSkill>(
    validation.skills.map((skill) => [skill.id, skill]),
  );
  const statuses = await Promise.all(
    [...snapshot.lock.skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(async (skill) => await assessSkill(registry, skill, libraryById.get(skill.id))),
  );
  return { libraryById, revision, snapshot, statuses };
}

function stateChanged(current: unknown, next: unknown): boolean {
  return current === undefined || stableJsonStringify(current) !== stableJsonStringify(next);
}

function assertGlobalSelection(selection: readonly ResolvedInstallSkill[]): void {
  if (selection.length === 0) {
    throw globalError(
      'MISSING_SKILL_SELECTION',
      'At least one skill must be selected.',
      EXIT_CODES.usage,
    );
  }
  const ids = selection.map((skill) => skill.id);
  if (new Set(ids).size !== ids.length) {
    throw globalError(
      'DUPLICATE_SKILL_SELECTION',
      'The selected skills contain duplicate IDs.',
      EXIT_CODES.validation,
      { ids },
    );
  }
}

async function validateSource(skill: ResolvedInstallSkill): Promise<void> {
  const tree = await inspectRegularFileTree(skill.rootPath, { rejectNestedSkillRoots: true });
  if (tree.digest !== skill.digest) {
    throw globalError(
      'LIBRARY_SKILL_CHANGED',
      `${skill.id} changed after catalog selection; refresh the library revision and retry.`,
      EXIT_CODES.validation,
    );
  }
}

interface InstallBuild {
  readonly mutations: readonly {
    readonly destination: string;
    readonly skill: ResolvedInstallSkill;
    readonly target: string;
  }[];
  readonly nextLock: ProjectLock;
  readonly nextManifest: ProjectManifest;
  readonly plan: GlobalInstallPlan;
}

export interface InstallGlobalSkillsOptions {
  readonly dryRun?: boolean;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operationId?: string;
  readonly paths: ApplicationPaths;
  readonly registry?: TargetRegistry;
  readonly skills: readonly ResolvedInstallSkill[];
  readonly storage?: ProjectMutationStorage;
  readonly targets: readonly TargetName[];
}

async function buildInstall(options: InstallGlobalSkillsOptions): Promise<InstallBuild> {
  assertGlobalSelection(options.skills);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.libraryRevision)) {
    throw globalError(
      'INVALID_LIBRARY_REVISION',
      'Library revision must be a full Git object ID.',
      EXIT_CODES.validation,
    );
  }
  const registry = options.registry ?? new TargetRegistry();
  const targets = uniqueSorted(options.targets) as readonly TargetName[];
  if (targets.length === 0) {
    throw globalError(
      'MISSING_TARGET_SELECTION',
      'At least one target is required.',
      EXIT_CODES.usage,
    );
  }
  await Promise.all(options.skills.map(validateSource));
  const snapshot = await readOptionalSnapshot(options.paths);
  if (
    snapshot.manifest?.library.identity !== undefined &&
    snapshot.manifest.library.identity !== options.libraryIdentity
  ) {
    throw globalError(
      'GLOBAL_LIBRARY_MISMATCH',
      `Global skills are already connected to library ${snapshot.manifest.library.identity}.`,
      EXIT_CODES.validation,
    );
  }

  const desiredById = new Map(snapshot.manifest?.skills.map((skill) => [skill.id, skill]) ?? []);
  const resolvedById = new Map(snapshot.lock?.skills.map((skill) => [skill.id, skill]) ?? []);
  const tracked = new Map<string, string>();
  for (const skill of snapshot.manifest?.skills ?? []) {
    for (const projection of skill.projections) {
      const destination = await destinationFor(registry, projection.target, projection.destination);
      tracked.set(`${projection.target}\0${destination}`, skill.id);
    }
  }

  const requested = new Map<string, string>();
  const mutations: { destination: string; skill: ResolvedInstallSkill; target: string }[] = [];
  const nextDesired = new Map(desiredById);
  const nextResolved = new Map(resolvedById);
  const skillPlans: GlobalInstallPlan['skills'][number][] = [];
  for (const skill of [...options.skills].sort((left, right) => left.id.localeCompare(right.id))) {
    const currentDesired = desiredById.get(skill.id);
    const currentResolved = resolvedById.get(skill.id);
    if (currentDesired !== undefined && currentResolved === undefined) {
      throw globalError(
        'INCOMPLETE_GLOBAL_STATE',
        `Tracked skill ${skill.id} has no lock entry.`,
        EXIT_CODES.validation,
      );
    }
    if (currentResolved !== undefined && currentResolved.canonicalDigest !== skill.digest) {
      throw globalError(
        'INSTALL_REQUIRES_UPDATE',
        `${skill.id} is already tracked at a different revision; use update or sync.`,
        EXIT_CODES.conflict,
      );
    }
    const desiredProjections = [...(currentDesired?.projections ?? [])];
    const resolvedProjections = [...(currentResolved?.projections ?? [])];
    let expanded = false;
    const projections: { destination: string; target: string; write: boolean }[] = [];
    for (const target of targets) {
      const destination = await destinationFor(registry, target, skill.name);
      const key = `${target}\0${destination}`;
      const requestedOwner = requested.get(key);
      if (requestedOwner !== undefined && requestedOwner !== skill.id) {
        throw globalError(
          'DESTINATION_COLLISION',
          `${requestedOwner} and ${skill.id} both map to ${destination}.`,
          EXIT_CODES.conflict,
        );
      }
      requested.set(key, skill.id);
      const existing = desiredProjections.find((projection) => projection.target === target);
      if (existing !== undefined && existing.destination !== skill.name) {
        throw globalError(
          'TARGET_MAPPING_CHANGED',
          `Tracked destination for ${skill.id} on ${target} differs from the active target adapter.`,
          EXIT_CODES.validation,
        );
      }
      const owner = tracked.get(key);
      if (owner !== undefined && owner !== skill.id) {
        throw globalError(
          'TRACKED_DESTINATION_COLLISION',
          `${destination} is managed by ${owner}.`,
          EXIT_CODES.conflict,
        );
      }
      const exists = await pathExists(destination);
      if (existing === undefined && exists) {
        throw globalError(
          'UNMANAGED_COLLISION',
          `${destination} already exists and is not a matching managed global skill.`,
          EXIT_CODES.conflict,
        );
      }
      if (existing !== undefined) {
        if (currentResolved === undefined) {
          throw globalError(
            'INCOMPLETE_GLOBAL_STATE',
            `Tracked skill ${skill.id} has no lock entry.`,
            EXIT_CODES.validation,
          );
        }
        const resolved = currentResolved.projections.find(
          (projection) => projection.target === target,
        );
        if (resolved === undefined) {
          throw globalError(
            'INCOMPLETE_GLOBAL_STATE',
            `Tracked skill ${skill.id} has incomplete target state.`,
            EXIT_CODES.validation,
          );
        }
        const actual = await inspectDestination(registry, currentResolved.baseDigest, resolved);
        if (!actual.exists || actual.changedFromRecorded) {
          throw globalError(
            actual.exists ? 'LOCAL_MODIFICATIONS_REFUSED' : 'MISSING_MANAGED_DESTINATION',
            actual.exists
              ? `${skill.id} has local changes; install will not overwrite them.`
              : `${skill.id} is missing; use sync to restore it.`,
            EXIT_CODES.conflict,
          );
        }
      } else {
        expanded ||= currentDesired !== undefined;
        desiredProjections.push({ destination: skill.name, target });
        resolvedProjections.push({ destination: skill.name, digest: skill.digest, target });
        mutations.push({ destination, skill, target });
      }
      projections.push({ destination, target, write: existing === undefined });
    }
    nextDesired.set(skill.id, { id: skill.id, projections: desiredProjections });
    nextResolved.set(skill.id, {
      baseDigest: currentResolved?.baseDigest ?? skill.digest,
      canonicalDigest: skill.digest,
      id: skill.id,
      projections: resolvedProjections,
    });
    skillPlans.push({
      digest: skill.digest,
      id: skill.id,
      projections,
      status:
        currentDesired === undefined
          ? 'install'
          : expanded
            ? 'expand-targets'
            : 'already-installed',
    });
  }
  const nextManifest = canonicalizeProjectManifest(
    projectManifestSchema.parse({
      gitignore: 'unmanaged',
      library: { identity: options.libraryIdentity },
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      skills: [...nextDesired.values()],
    }),
  );
  const nextLock = canonicalizeProjectLock(
    projectLockSchema.parse({
      library: {
        identity: options.libraryIdentity,
        revision:
          snapshot.lock === undefined || mutations.length > 0
            ? options.libraryRevision
            : snapshot.lock.library.revision,
      },
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      skills: [...nextResolved.values()],
    }),
  );
  const changedManifest = stateChanged(snapshot.manifest, nextManifest);
  const changedLock = stateChanged(snapshot.lock, nextLock);
  const files = stateFiles(options.paths);
  return {
    mutations,
    nextLock,
    nextManifest,
    plan: {
      applied: false,
      dryRun: options.dryRun === true,
      libraryRevision: options.libraryRevision,
      operation: 'install',
      scope: 'global',
      stateDirectory: stateDirectory(options.paths),
      skills: skillPlans,
      state: { lockChanged: changedLock, manifestChanged: changedManifest },
      writes: uniqueSorted([
        ...mutations.map((mutation) => mutation.destination),
        ...(changedManifest ? [files.manifest] : []),
        ...(changedLock ? [files.lock] : []),
      ]),
    },
  };
}

function requireStorage(storage: ProjectMutationStorage | undefined): ProjectMutationStorage {
  if (storage === undefined) {
    throw globalError(
      'MISSING_TRANSACTION_STORAGE',
      'Global mutation storage is required.',
      EXIT_CODES.usage,
    );
  }
  return storage;
}

async function writeStagedJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, stableJsonStringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export async function installGlobalSkills(
  options: InstallGlobalSkillsOptions,
): Promise<GlobalInstallPlan> {
  const initial = await buildInstall(options);
  if (options.dryRun === true || initial.plan.writes.length === 0) return initial.plan;
  const storage = requireStorage(options.storage);
  const operationId = options.operationId ?? `global-install-${randomUUID()}`;
  const lock = await acquireAdvisoryLock(storage.lockPath, { operationId });
  let staging: string | undefined;
  try {
    const build = await buildInstall(options);
    if (build.plan.writes.length === 0) return build.plan;
    staging = await createStagingDirectory(storage.stagingRoot, operationId);
    const staged = new Map<string, string>();
    const replacements: AtomicReplacement[] = [];
    for (const mutation of build.mutations) {
      let stagedSkill = staged.get(mutation.skill.id);
      if (stagedSkill === undefined) {
        stagedSkill = await stageRegularPath(
          mutation.skill.rootPath,
          staging,
          `skills/${mutation.skill.id}`,
        );
        const checked = await inspectRegularFileTree(stagedSkill, { rejectNestedSkillRoots: true });
        if (checked.digest !== mutation.skill.digest) {
          throw globalError(
            'STAGED_DIGEST_MISMATCH',
            `Staged bytes for ${mutation.skill.id} did not match.`,
            EXIT_CODES.validation,
          );
        }
        staged.set(mutation.skill.id, stagedSkill);
      }
      replacements.push({
        action: 'replace',
        destinationPath: mutation.destination,
        stagedPath: stagedSkill,
      });
    }
    const files = stateFiles(options.paths);
    if (build.plan.state.manifestChanged) {
      const path = `${staging}/${GLOBAL_MANIFEST_FILENAME}`;
      await writeStagedJson(path, build.nextManifest);
      replacements.push({ action: 'replace', destinationPath: files.manifest, stagedPath: path });
    }
    if (build.plan.state.lockChanged) {
      const path = `${staging}/${GLOBAL_LOCK_FILENAME}`;
      await writeStagedJson(path, build.nextLock);
      replacements.push({ action: 'replace', destinationPath: files.lock, stagedPath: path });
    }
    await replacePathsAtomically({
      journalDirectory: storage.journalDirectory,
      kind: 'global-install',
      operationId,
      replacements,
      root: commonRoot([
        ...replacements.map((replacement) => replacement.destinationPath),
        stateDirectory(options.paths),
      ]),
    });
    return { ...build.plan, applied: true };
  } finally {
    if (staging !== undefined)
      await rm(staging, { force: true, recursive: true }).catch(() => undefined);
    await lock.release();
  }
}

interface AdoptGlobalBuild {
  readonly backupEntries: readonly { readonly path: string; readonly relativePath: string }[];
  readonly nextLock: ProjectLock;
  readonly nextManifest: ProjectManifest;
  readonly plan: GlobalAdoptPlan;
  readonly transactionRoot: string;
}

async function buildAdopt(options: AdoptGlobalSkillOptions): Promise<AdoptGlobalBuild> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.libraryRevision)) {
    throw globalError(
      'INVALID_LIBRARY_REVISION',
      'Library revision must be a full Git object ID.',
      EXIT_CODES.validation,
    );
  }
  if (!options.skill.compatibleAgents.includes(options.target)) {
    throw globalError(
      'INCOMPATIBLE_TARGET',
      `${options.skill.id} does not declare compatibility with ${options.target}.`,
      EXIT_CODES.validation,
      { id: options.skill.id, target: options.target },
    );
  }

  const registry = options.registry ?? new TargetRegistry();
  let destination: string;
  try {
    destination = await destinationFor(registry, options.target, options.skill.name);
  } catch (error) {
    throw globalError(
      'UNSAFE_ADOPTION_DESTINATION',
      error instanceof Error ? error.message : 'The selected global target destination is unsafe.',
      EXIT_CODES.validation,
      { target: options.target },
    );
  }
  try {
    const information = await lstat(destination);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw globalError(
        'UNMANAGED_SKILL_INVALID',
        `The ${options.target} global skill directory is not a regular directory: ${destination}.`,
        EXIT_CODES.validation,
        { path: destination, target: options.target },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw globalError(
        'UNMANAGED_SKILL_NOT_FOUND',
        `No unmanaged global ${options.target} skill exists at ${destination}.`,
        EXIT_CODES.validation,
        { path: destination, target: options.target },
      );
    }
    throw error;
  }

  await validateSource(options.skill);
  const local = await validateSkillDirectory(destination, options.skill.name);
  if (!local.valid || local.skill === null) {
    throw globalError(
      'UNMANAGED_SKILL_INVALID',
      `The unmanaged global ${options.target} skill at ${destination} is not valid: ${local.errors
        .map((issue) => issue.message)
        .join(' ')}`,
      EXIT_CODES.validation,
      { path: destination, target: options.target },
    );
  }
  if (local.skill.digest !== options.skill.digest) {
    throw globalError(
      'ADOPTION_DIGEST_MISMATCH',
      `${destination} does not exactly match canonical skill ${options.skill.id}; it was left unchanged.`,
      EXIT_CODES.conflict,
      { id: options.skill.id, path: destination, target: options.target },
    );
  }

  const snapshot = await readOptionalSnapshot(options.paths);
  if (
    snapshot.manifest?.library.identity !== undefined &&
    snapshot.manifest.library.identity !== options.libraryIdentity
  ) {
    throw globalError(
      'GLOBAL_LIBRARY_MISMATCH',
      `Global skills are already connected to library ${snapshot.manifest.library.identity}.`,
      EXIT_CODES.validation,
    );
  }
  const desiredById = new Map(snapshot.manifest?.skills.map((skill) => [skill.id, skill]) ?? []);
  if (desiredById.has(options.skill.id)) {
    throw globalError(
      'SKILL_ALREADY_MANAGED',
      `${options.skill.id} is already managed globally; use sync or update instead.`,
      EXIT_CODES.conflict,
      { id: options.skill.id },
    );
  }
  for (const desired of snapshot.manifest?.skills ?? []) {
    for (const projection of desired.projections) {
      if (projection.target !== options.target) continue;
      const trackedDestination = await destinationFor(
        registry,
        projection.target,
        projection.destination,
      );
      if (trackedDestination === destination) {
        throw globalError(
          'TRACKED_DESTINATION_COLLISION',
          `${destination} is already managed by ${desired.id}.`,
          EXIT_CODES.conflict,
          { id: options.skill.id, owner: desired.id, path: destination },
        );
      }
    }
  }

  const nextManifest = canonicalizeProjectManifest(
    projectManifestSchema.parse({
      gitignore: snapshot.manifest?.gitignore ?? 'unmanaged',
      library: { identity: options.libraryIdentity },
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      skills: [
        ...(snapshot.manifest?.skills ?? []),
        {
          id: options.skill.id,
          projections: [{ destination: options.skill.name, target: options.target }],
        },
      ],
    }),
  );
  const nextLock = canonicalizeProjectLock(
    projectLockSchema.parse({
      library: { identity: options.libraryIdentity, revision: options.libraryRevision },
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      skills: [
        ...(snapshot.lock?.skills ?? []),
        {
          baseDigest: options.skill.digest,
          canonicalDigest: options.skill.digest,
          id: options.skill.id,
          projections: [
            {
              destination: options.skill.name,
              digest: options.skill.digest,
              target: options.target,
            },
          ],
        },
      ],
    }),
  );
  const files = stateFiles(options.paths);
  const transactionRoot = commonRoot([
    stateDirectory(options.paths),
    files.manifest,
    files.lock,
    destination,
  ]);
  const manifestChanged = stateChanged(snapshot.manifest, nextManifest);
  const lockChanged = stateChanged(snapshot.lock, nextLock);
  return {
    backupEntries:
      snapshot.manifest === undefined
        ? []
        : [
            { path: files.manifest, relativePath: relativeFrom(transactionRoot, files.manifest) },
            { path: files.lock, relativePath: relativeFrom(transactionRoot, files.lock) },
          ],
    nextLock,
    nextManifest,
    plan: {
      applied: false,
      dryRun: options.dryRun === true,
      libraryRevision: options.libraryRevision,
      operation: 'adopt',
      scope: 'global',
      skill: {
        destination,
        digest: options.skill.digest,
        id: options.skill.id,
        target: options.target,
      },
      state: { lockChanged, manifestChanged },
      stateDirectory: stateDirectory(options.paths),
      writes: uniqueSorted([
        ...(manifestChanged ? [files.manifest] : []),
        ...(lockChanged ? [files.lock] : []),
      ]),
    },
    transactionRoot,
  };
}

/** Adopt an exact, validated unmanaged global copy without replacing target files. */
export async function adoptGlobalSkill(options: AdoptGlobalSkillOptions): Promise<GlobalAdoptPlan> {
  const initial = await buildAdopt(options);
  if (options.dryRun === true || initial.plan.writes.length === 0) return initial.plan;

  const storage = requireStorage(options.storage);
  const operationId = options.operationId ?? `global-adopt-${randomUUID()}`;
  const lock = await acquireAdvisoryLock(storage.lockPath, { operationId });
  let staging: string | undefined;
  try {
    const build = await buildAdopt(options);
    if (build.plan.writes.length === 0) return build.plan;
    if (build.backupEntries.length > 0) {
      await createRecoverableBackup({
        backupRoot: storage.backupRoot,
        entries: build.backupEntries,
        operationId,
        projectRoot: build.transactionRoot,
      });
    }
    staging = await createStagingDirectory(storage.stagingRoot, operationId);
    const files = stateFiles(options.paths);
    const manifest = `${staging}/${GLOBAL_MANIFEST_FILENAME}`;
    const stateLock = `${staging}/${GLOBAL_LOCK_FILENAME}`;
    await writeStagedJson(manifest, build.nextManifest);
    await writeStagedJson(stateLock, build.nextLock);
    await replacePathsAtomically({
      journalDirectory: storage.journalDirectory,
      kind: 'global-adopt',
      operationId,
      replacements: [
        { action: 'replace', destinationPath: files.manifest, stagedPath: manifest },
        { action: 'replace', destinationPath: files.lock, stagedPath: stateLock },
      ],
      root: build.transactionRoot,
    });
    return { ...build.plan, applied: true };
  } finally {
    if (staging !== undefined)
      await rm(staging, { force: true, recursive: true }).catch(() => undefined);
    await lock.release();
  }
}

export interface UninstallGlobalSkillsOptions {
  readonly confirmed?: boolean;
  readonly discardLocal?: boolean;
  readonly dryRun?: boolean;
  readonly operationId?: string;
  readonly paths: ApplicationPaths;
  readonly registry?: TargetRegistry;
  readonly skillIds: readonly string[];
  readonly storage?: ProjectMutationStorage;
}

interface UninstallBuild {
  readonly backupEntries: readonly { readonly path: string; readonly relativePath: string }[];
  readonly nextLock: ProjectLock;
  readonly nextManifest: ProjectManifest;
  readonly plan: GlobalUninstallPlan;
  readonly removals: readonly { readonly destination: string; readonly exists: boolean }[];
  readonly transactionRoot: string;
}

async function buildUninstall(options: UninstallGlobalSkillsOptions): Promise<UninstallBuild> {
  const ids = uniqueSorted(options.skillIds);
  if (ids.length === 0 || ids.length !== options.skillIds.length) {
    throw globalError(
      'MISSING_SKILL_SELECTION',
      'Select one or more unique managed global skills.',
      EXIT_CODES.usage,
    );
  }
  const registry = options.registry ?? new TargetRegistry();
  const snapshot = await readSnapshot(options.paths);
  const desired = new Map(snapshot.manifest.skills.map((skill) => [skill.id, skill]));
  const resolved = new Map(snapshot.lock.skills.map((skill) => [skill.id, skill]));
  const unknown = ids.filter((id) => !desired.has(id));
  if (unknown.length > 0) {
    throw globalError(
      'SKILL_NOT_MANAGED',
      `Not globally managed: ${unknown.join(', ')}.`,
      EXIT_CODES.validation,
      { ids: unknown },
    );
  }
  const plans: GlobalUninstallPlan['skills'][number][] = [];
  const removals: { destination: string; exists: boolean }[] = [];
  for (const id of ids) {
    const locked = resolved.get(id);
    if (locked === undefined)
      throw globalError(
        'INCOMPLETE_GLOBAL_STATE',
        `${id} has no lock entry.`,
        EXIT_CODES.validation,
      );
    const inspected = await Promise.all(
      locked.projections.map(
        async (projection) => await inspectDestination(registry, locked.baseDigest, projection),
      ),
    );
    plans.push({
      id,
      locallyModified: inspected.some((entry) => entry.changedFromRecorded),
      projections: inspected.map((entry) => ({
        destination: entry.path,
        target: entry.target,
        write: entry.exists,
      })),
    });
    removals.push(...inspected.map((entry) => ({ destination: entry.path, exists: entry.exists })));
  }
  const modified = plans.filter((plan) => plan.locallyModified);
  if (modified.length > 0 && options.discardLocal !== true) {
    throw globalError(
      'LOCAL_MODIFICATIONS_REFUSED',
      `Refusing to uninstall edited global skills: ${modified.map((skill) => skill.id).join(', ')}.`,
      EXIT_CODES.conflict,
    );
  }
  if (modified.length > 0 && options.dryRun !== true && options.confirmed !== true) {
    throw globalError(
      'DESTRUCTIVE_CONFIRMATION_REQUIRED',
      'Discarding global skill edits requires explicit confirmation.',
      EXIT_CODES.usage,
    );
  }
  const nextManifest = canonicalizeProjectManifest({
    ...snapshot.manifest,
    skills: snapshot.manifest.skills.filter((skill) => !ids.includes(skill.id)),
  });
  const nextLock = canonicalizeProjectLock({
    ...snapshot.lock,
    skills: snapshot.lock.skills.filter((skill) => !ids.includes(skill.id)),
  });
  const files = stateFiles(options.paths);
  const transactionRoot = commonRoot([
    snapshot.stateDirectory,
    files.manifest,
    files.lock,
    ...removals.map((entry) => entry.destination),
  ]);
  const backupPaths =
    modified.length === 0
      ? []
      : uniqueSorted([
          ...removals.filter((entry) => entry.exists).map((entry) => entry.destination),
          files.manifest,
          files.lock,
        ]);
  return {
    backupEntries: backupPaths.map((path) => ({
      path,
      relativePath: relativeFrom(transactionRoot, path),
    })),
    nextLock,
    nextManifest,
    plan: {
      applied: false,
      backup: { paths: backupPaths, required: backupPaths.length > 0 },
      dryRun: options.dryRun === true,
      libraryRevision: snapshot.lock.library.revision,
      operation: 'uninstall',
      scope: 'global',
      stateDirectory: snapshot.stateDirectory,
      skills: plans,
      state: { lockChanged: true, manifestChanged: true },
      writes: uniqueSorted([
        ...removals.filter((entry) => entry.exists).map((entry) => entry.destination),
        files.manifest,
        files.lock,
      ]),
    },
    removals,
    transactionRoot,
  };
}

export async function uninstallGlobalSkills(
  options: UninstallGlobalSkillsOptions,
): Promise<GlobalUninstallPlan> {
  const initial = await buildUninstall(options);
  if (options.dryRun === true) return initial.plan;
  const storage = requireStorage(options.storage);
  const operationId = options.operationId ?? `global-uninstall-${randomUUID()}`;
  const lock = await acquireAdvisoryLock(storage.lockPath, { operationId });
  let staging: string | undefined;
  try {
    const build = await buildUninstall(options);
    if (build.plan.backup.required) {
      await createRecoverableBackup({
        backupRoot: storage.backupRoot,
        entries: build.backupEntries,
        operationId,
        projectRoot: build.transactionRoot,
      });
    }
    staging = await createStagingDirectory(storage.stagingRoot, operationId);
    const files = stateFiles(options.paths);
    const manifest = `${staging}/${GLOBAL_MANIFEST_FILENAME}`;
    const stateLock = `${staging}/${GLOBAL_LOCK_FILENAME}`;
    await writeStagedJson(manifest, build.nextManifest);
    await writeStagedJson(stateLock, build.nextLock);
    const replacements: AtomicReplacement[] = [
      ...build.removals
        .filter((entry) => entry.exists)
        .map((entry) => ({ action: 'remove' as const, destinationPath: entry.destination })),
      { action: 'replace', destinationPath: files.manifest, stagedPath: manifest },
      { action: 'replace', destinationPath: files.lock, stagedPath: stateLock },
    ];
    await replacePathsAtomically({
      journalDirectory: storage.journalDirectory,
      kind: 'global-uninstall',
      operationId,
      replacements,
      root: build.transactionRoot,
    });
    return { ...build.plan, applied: true };
  } finally {
    if (staging !== undefined)
      await rm(staging, { force: true, recursive: true }).catch(() => undefined);
    await lock.release();
  }
}

export interface GlobalInspectionOptions {
  readonly allowStale?: boolean;
  readonly library: LibraryRevisionProvider;
  readonly offline?: boolean;
  readonly paths: ApplicationPaths;
  readonly registry?: TargetRegistry;
}

function inspectionRequest(
  options: GlobalInspectionOptions,
): Parameters<LibraryRevisionProvider['resolve']>[0] {
  return {
    ...(options.offline ? { cacheOnly: true } : { allowStale: options.allowStale ?? true }),
    purpose: 'inspection',
  };
}

export async function inspectGlobalStatus(
  options: GlobalInspectionOptions,
): Promise<GlobalStatusReport> {
  const revision = await options.library.resolve(inspectionRequest(options));
  try {
    const inspected = await inspectRevision(
      options.paths,
      options.registry ?? new TargetRegistry(),
      revision,
    );
    return {
      authoritative: !revision.stale,
      branch: revision.branch,
      freshness: revision.freshness,
      libraryIdentity: revision.identity,
      libraryRevision: revision.revision,
      operation: 'status',
      refreshedAt: revision.refreshedAt,
      scope: 'global',
      skills: inspected.statuses,
      stale: revision.stale,
      stateDirectory: inspected.snapshot.stateDirectory,
      ...(revision.warning === undefined ? {} : { warning: revision.warning }),
    };
  } finally {
    await revision.release?.();
  }
}

function compareInventories(
  libraryFiles: readonly RegularFileInventoryEntry[],
  localFiles: readonly RegularFileInventoryEntry[],
): ProjectDiffReport['targets'][number]['differences'] {
  const expected = new Map(libraryFiles.map((file) => [file.relativePath, file]));
  const actual = new Map(localFiles.map((file) => [file.relativePath, file]));
  const differences: ProjectDiffReport['targets'][number]['differences'][number][] = [];
  for (const path of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const left = expected.get(path);
    const right = actual.get(path);
    if (left === undefined && right !== undefined) {
      differences.push({ kind: 'local-only', localSha256: right.sha256, path });
    } else if (left !== undefined && right === undefined) {
      differences.push({ kind: 'library-only', librarySha256: left.sha256, path });
    } else if (left !== undefined && right !== undefined && left.sha256 !== right.sha256) {
      differences.push({
        kind: 'different',
        librarySha256: left.sha256,
        localSha256: right.sha256,
        path,
      });
    }
  }
  return differences;
}

export async function inspectGlobalDiff(
  options: GlobalInspectionOptions & { readonly selector: string },
): Promise<GlobalDiffReport> {
  const revision = await options.library.resolve(inspectionRequest(options));
  try {
    const inspected = await inspectRevision(
      options.paths,
      options.registry ?? new TargetRegistry(),
      revision,
    );
    const selected = resolveSkillSelectors(inspected.statuses, [options.selector]);
    if (!selected.success || selected.values[0] === undefined) {
      throw globalError(
        'INVALID_SKILL_SELECTION',
        selected.success
          ? 'A tracked skill is required.'
          : selected.errors.map((error) => error.message).join('\n'),
        EXIT_CODES.validation,
      );
    }
    const status = selected.values[0];
    const library = inspected.libraryById.get(status.id);
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
      scope: 'global',
      stale: revision.stale,
      state: status.state,
      stateDirectory: inspected.snapshot.stateDirectory,
      targets: status.destinations.map((destination) => ({
        destination: destination.path,
        differences:
          destination.inspectionError === undefined
            ? compareInventories(library?.files ?? [], destination.inventory)
            : [{ kind: 'unreadable' as const, path: '.' }],
        ...(destination.digest === undefined ? {} : { digest: destination.digest }),
        divergentFromOtherTargets: status.assessment.divergentTargets.includes(destination.target),
        exists: destination.exists,
        target: destination.target,
      })),
      ...(revision.warning === undefined ? {} : { warning: revision.warning }),
    };
  } finally {
    await revision.release?.();
  }
}

function actionFor(state: ReconciliationState, discardLocal: boolean): ReconciliationAction {
  switch (state) {
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

function planOutcomes(
  statuses: readonly ProjectSkillStatus[],
  discardLocal: boolean,
): ReconciliationSkillResult[] {
  return statuses.map((status) => {
    const action = actionFor(status.state, discardLocal);
    return {
      ...status,
      action,
      backupPaths:
        action === 'discard-local'
          ? status.destinations
              .filter((destination) => destination.exists)
              .map((destination) => destination.path)
          : [],
      outcome: action === 'none' ? 'unchanged' : action.startsWith('skip-') ? 'skipped' : 'planned',
      writes: ['update', 'restore', 'discard-local'].includes(action)
        ? status.destinations.map((destination) => destination.path)
        : [],
    };
  });
}

function selectForOperation(
  operation: 'sync' | 'update',
  statuses: readonly ProjectSkillStatus[],
  selectors: readonly string[] | undefined,
  all: boolean,
): readonly ProjectSkillStatus[] {
  if (operation === 'sync' || all) {
    if (operation === 'update' && (selectors?.length ?? 0) > 0) {
      throw globalError(
        'CONFLICTING_SELECTION',
        'update --all cannot be combined with skill selectors.',
        EXIT_CODES.usage,
      );
    }
    const selected = selectAllSkills(statuses);
    if (!selected.success)
      throw globalError(
        'INVALID_SKILL_SELECTION',
        selected.errors.map((error) => error.message).join('\n'),
        EXIT_CODES.validation,
      );
    return selected.values;
  }
  if (selectors === undefined || selectors.length === 0) {
    throw globalError(
      'MISSING_SKILL_SELECTION',
      'update requires skill selectors or --all.',
      EXIT_CODES.usage,
    );
  }
  const selected = resolveSkillSelectors(statuses, selectors);
  if (!selected.success)
    throw globalError(
      'INVALID_SKILL_SELECTION',
      selected.errors.map((error) => error.message).join('\n'),
      EXIT_CODES.validation,
    );
  return selected.values;
}

function requireFreshRevision(
  revision: ResolvedLibraryRevision,
  offlineRevision: string | undefined,
): void {
  if (
    !revision.usableForMutation ||
    (revision.stale && revision.freshness !== 'offline-revision')
  ) {
    throw globalError(
      'FRESH_LIBRARY_REVISION_REQUIRED',
      'Global reconciliation requires a fresh or explicitly selected cached revision.',
      EXIT_CODES.repository,
    );
  }
  if (revision.freshness === 'offline-revision' && offlineRevision === undefined) {
    throw globalError(
      'EXPLICIT_OFFLINE_REVISION_REQUIRED',
      'Applying an offline revision requires an explicit revision.',
      EXIT_CODES.repository,
    );
  }
}

export interface GlobalReconciliationOptions {
  readonly all?: boolean;
  readonly check?: boolean;
  readonly confirmed?: boolean;
  readonly discardLocal?: boolean;
  readonly dryRun?: boolean;
  readonly hooks?: ReconciliationTransactionHooks;
  readonly library: LibraryRevisionProvider;
  readonly offlineRevision?: string;
  readonly operationId?: string;
  readonly paths: ApplicationPaths;
  readonly registry?: TargetRegistry;
  readonly selectors?: readonly string[];
  readonly storage?: ProjectMutationStorage;
}

function report(
  operation: 'sync' | 'update',
  inspection: GlobalInspection,
  results: readonly ReconciliationSkillResult[],
  check: boolean,
  dryRun: boolean,
): GlobalReconciliationReport {
  const applied = results.some((entry) =>
    ['updated', 'restored', 'discarded-local'].includes(entry.outcome),
  );
  const skipped = results.some((entry) => entry.outcome === 'skipped');
  const failed = results.some((entry) => entry.outcome === 'failed');
  const exitCode = check
    ? inspection.revision.stale
      ? EXIT_CODES.repository
      : results.some((entry) => entry.state !== 'current')
        ? EXIT_CODES.conflict
        : EXIT_CODES.success
    : failed
      ? EXIT_CODES.internal
      : skipped
        ? EXIT_CODES.conflict
        : EXIT_CODES.success;
  return {
    applied,
    authoritative: !inspection.revision.stale,
    branch: inspection.revision.branch,
    check,
    dryRun,
    exitCode,
    freshness: inspection.revision.freshness,
    libraryIdentity: inspection.revision.identity,
    libraryRevision: inspection.revision.revision,
    operation,
    scope: 'global',
    selectedIds: results.map((entry) => entry.id),
    skills: results,
    stale: inspection.revision.stale,
    stateDirectory: inspection.snapshot.stateDirectory,
    ...(inspection.revision.warning === undefined ? {} : { warning: inspection.revision.warning }),
    wouldChange: results.some((entry) =>
      ['update', 'restore', 'discard-local'].includes(entry.action),
    ),
  };
}

async function reconcile(
  operation: 'sync' | 'update',
  options: GlobalReconciliationOptions,
): Promise<GlobalReconciliationReport> {
  const revision = await options.library.resolve({
    ...(options.offlineRevision === undefined ? {} : { offlineRevision: options.offlineRevision }),
    purpose: 'application',
  });
  try {
    requireFreshRevision(revision, options.offlineRevision);
    const registry = options.registry ?? new TargetRegistry();
    let inspection = await inspectRevision(options.paths, registry, revision);
    let selected = selectForOperation(
      operation,
      inspection.statuses,
      options.selectors,
      operation === 'sync' || options.all === true,
    );
    let results = planOutcomes(selected, options.discardLocal === true);
    const check = options.check === true;
    const dryRun = options.dryRun === true || check;
    const destructive = results.filter((entry) => entry.action === 'discard-local');
    if (destructive.length > 0 && !dryRun && options.confirmed !== true) {
      throw globalError(
        'DESTRUCTIVE_CONFIRMATION_REQUIRED',
        'Discarding global edits requires confirmation after review.',
        EXIT_CODES.usage,
      );
    }
    if (dryRun || !results.some((entry) => entry.writes.length > 0))
      return report(operation, inspection, results, check, dryRun);

    const storage = requireStorage(options.storage);
    const operationId = options.operationId ?? `global-${operation}-${randomUUID()}`;
    const lock = await acquireAdvisoryLock(storage.lockPath, { operationId });
    let staging: string | undefined;
    try {
      inspection = await inspectRevision(options.paths, registry, revision);
      selected = selectForOperation(
        operation,
        inspection.statuses,
        options.selectors,
        operation === 'sync' || options.all === true,
      );
      results = planOutcomes(selected, options.discardLocal === true);
      if (results.some((entry) => entry.action === 'discard-local') && options.confirmed !== true) {
        throw globalError(
          'DESTRUCTIVE_CONFIRMATION_REQUIRED',
          'Global content changed before application.',
          EXIT_CODES.usage,
        );
      }
      const writable = results.filter((entry) =>
        ['update', 'restore', 'discard-local'].includes(entry.action),
      );
      if (writable.length === 0) return report(operation, inspection, results, false, false);
      const files = stateFiles(options.paths);
      const transactionRoot = commonRoot([
        inspection.snapshot.stateDirectory,
        files.lock,
        ...writable.flatMap((entry) => entry.destinations.map((destination) => destination.path)),
      ]);
      const backupEntries = writable
        .filter((entry) => entry.action === 'discard-local')
        .flatMap((entry) =>
          entry.destinations
            .filter((destination) => destination.exists)
            .map((destination) => destination.path),
        );
      if (backupEntries.length > 0) {
        await createRecoverableBackup({
          backupRoot: storage.backupRoot,
          entries: uniqueSorted([...backupEntries, files.manifest, files.lock]).map((path) => ({
            path,
            relativePath: relativeFrom(transactionRoot, path),
          })),
          operationId: `${operationId}-backup`,
          projectRoot: transactionRoot,
        });
      }
      const nextLock = canonicalizeProjectLock({
        ...inspection.snapshot.lock,
        library: { ...inspection.snapshot.lock.library, revision: revision.revision },
        skills: inspection.snapshot.lock.skills.map((skill) => {
          const status = writable.find((entry) => entry.id === skill.id);
          if (status === undefined) return skill;
          const digest = status.libraryDigest;
          if (digest === undefined) return skill;
          return {
            baseDigest: digest,
            canonicalDigest: digest,
            id: skill.id,
            projections: skill.projections.map((projection) => ({ ...projection, digest })),
          };
        }),
      });
      staging = await createStagingDirectory(storage.stagingRoot, operationId);
      const replacements: AtomicReplacement[] = [];
      for (const [index, item] of writable.entries()) {
        const library = inspection.libraryById.get(item.id);
        if (library === undefined)
          throw globalError(
            'ORPHANED_SKILL',
            `${item.id} is absent from the library.`,
            EXIT_CODES.conflict,
          );
        const staged = await stageRegularPath(
          library.rootPath,
          staging,
          `skills/${String(index)}-${item.id}`,
        );
        const tree = await inspectRegularFileTree(staged, { rejectNestedSkillRoots: true });
        if (tree.digest !== library.digest)
          throw globalError(
            'STAGED_DIGEST_MISMATCH',
            `Staged ${item.id} failed validation.`,
            EXIT_CODES.validation,
          );
        replacements.push(
          ...item.destinations.map((destination) => ({
            action: 'replace' as const,
            destinationPath: destination.path,
            stagedPath: staged,
          })),
        );
      }
      const stagedLock = `${staging}/${GLOBAL_LOCK_FILENAME}`;
      await writeStagedJson(stagedLock, nextLock);
      replacements.push({ action: 'replace', destinationPath: files.lock, stagedPath: stagedLock });
      await replacePathsAtomically({
        ...(options.hooks?.beforeCommit === undefined
          ? {}
          : {
              hooks: {
                beforeCommit: async (index) =>
                  await options.hooks?.beforeCommit?.({
                    index,
                    skillId: writable[0]?.id ?? 'global',
                  }),
              },
            }),
        journalDirectory: storage.journalDirectory,
        kind: `global-${operation}`,
        operationId,
        replacements,
        root: transactionRoot,
      });
      const outcomes = results.map((entry): ReconciliationSkillResult => ({
        ...entry,
        outcome:
          entry.action === 'restore'
            ? 'restored'
            : entry.action === 'discard-local'
              ? 'discarded-local'
              : entry.action === 'update'
                ? 'updated'
                : entry.outcome,
      }));
      return report(operation, inspection, outcomes, false, false);
    } finally {
      if (staging !== undefined)
        await rm(staging, { force: true, recursive: true }).catch(() => undefined);
      await lock.release();
    }
  } finally {
    await revision.release?.();
  }
}

export async function syncGlobalSkills(
  options: GlobalReconciliationOptions,
): Promise<GlobalReconciliationReport> {
  return await reconcile('sync', options);
}

export async function updateGlobalSkills(
  options: GlobalReconciliationOptions,
): Promise<GlobalReconciliationReport> {
  return await reconcile('update', options);
}

export function formatGlobalStatusHuman(report: GlobalStatusReport): string {
  const lines = [
    `Scope: global`,
    `State: ${report.stateDirectory}`,
    `Library: ${report.libraryIdentity} @ ${report.libraryRevision}`,
  ];
  if (report.skills.length === 0) lines.push('No managed global skills.');
  for (const skill of report.skills) {
    lines.push(`${skill.id}: ${skill.state}`);
    for (const destination of skill.destinations)
      lines.push(`  ${destination.target} ${destination.path}`);
  }
  return lines.join('\n');
}

export function formatGlobalDiffHuman(report: GlobalDiffReport): string {
  const lines = [
    `Scope: global`,
    `${report.id}: ${report.state}`,
    `Library revision: ${report.libraryRevision}`,
  ];
  for (const target of report.targets) {
    lines.push(`${target.target} ${target.destination}:`);
    lines.push(
      ...(target.differences.length === 0
        ? ['  no content differences']
        : target.differences.map((difference) => `  ${difference.kind}: ${difference.path}`)),
    );
  }
  return lines.join('\n');
}

export function formatGlobalReconciliationHuman(report: GlobalReconciliationReport): string {
  const mode = report.check ? 'check' : report.dryRun ? 'dry-run' : 'apply';
  const lines = [
    `${report.operation} (${mode}, global): ${report.stateDirectory}`,
    `Library: ${report.libraryIdentity} @ ${report.libraryRevision}`,
  ];
  for (const skill of report.skills) lines.push(`${skill.id}: ${skill.state} -> ${skill.outcome}`);
  return lines.join('\n');
}
