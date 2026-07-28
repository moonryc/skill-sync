import { lstat, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CatalogSkillRecord } from './catalog.js';
import { preflightTargets, type ProjectionPlan } from './target-preflight.js';
import { inspectRegularFileTree, sha256TreeDigest } from '../domain/digest.js';
import { validateSkillDirectory } from '../domain/library.js';
import {
  PROJECT_LOCK_FILENAME,
  PROJECT_LOCK_SCHEMA_VERSION,
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  canonicalizeProjectLock,
  canonicalizeProjectManifest,
  libraryIdentitySchema,
  projectLockSchema,
  projectManifestSchema,
  type DesiredSkill,
  type ProjectLock,
  type ProjectManifest,
  type ResolvedSkill,
} from '../domain/project-state.js';
import { EXIT_CODES, SkillSyncError } from '../domain/result.js';
import { updateManagedGitignore, type GitignoreUpdate } from '../infrastructure/gitignore.js';
import {
  assertProjectStatePair,
  readProjectLock,
  readProjectManifest,
  resolveContainedProjectPath,
} from '../infrastructure/project-state.js';
import { stableJsonStringify } from '../infrastructure/stable-json.js';
import {
  acquireAdvisoryLock,
  createRecoverableBackup,
  createStagingDirectory,
  replacePathsAtomically,
  stageRegularPath,
  type AtomicReplacement,
} from '../infrastructure/transactions.js';
import { TargetRegistry, type TargetName } from '../targets/index.js';

export interface ProjectMutationStorage {
  readonly backupRoot: string;
  readonly journalDirectory: string;
  readonly lockPath: string;
  readonly stagingRoot: string;
}

/** Selection and fetch are deliberately outside this service. */
export type ResolvedInstallSkill = Pick<CatalogSkillRecord, 'digest' | 'id' | 'name' | 'rootPath'>;

export type InstallDisposition = 'install' | 'expand-targets' | 'already-installed';

export interface PlannedProjection {
  readonly destination: string;
  readonly target: string;
  readonly write: boolean;
}

export interface InstallSkillPlan {
  readonly digest: string;
  readonly id: string;
  readonly projections: readonly PlannedProjection[];
  readonly status: InstallDisposition;
}

export interface BackupPlan {
  readonly required: boolean;
  readonly paths: readonly string[];
}

export interface ProjectStatePlan {
  readonly lockChanged: boolean;
  readonly manifestChanged: boolean;
}

export interface InstallPlan {
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly gitignore: GitignoreUpdate;
  readonly libraryRevision: string;
  readonly operation: 'install';
  readonly projectRoot: string;
  readonly skills: readonly InstallSkillPlan[];
  readonly state: ProjectStatePlan;
  readonly writes: readonly string[];
}

export interface UninstallSkillPlan {
  readonly id: string;
  readonly locallyModified: boolean;
  readonly projections: readonly PlannedProjection[];
}

export interface UninstallPlan {
  readonly applied: boolean;
  readonly backup: BackupPlan;
  readonly dryRun: boolean;
  readonly gitignore: GitignoreUpdate;
  readonly libraryRevision: string;
  readonly operation: 'uninstall';
  readonly projectRoot: string;
  readonly skills: readonly UninstallSkillPlan[];
  readonly state: ProjectStatePlan;
  readonly writes: readonly string[];
}

export interface InstallProjectSkillsOptions {
  readonly dryRun?: boolean;
  readonly gitignore?: ProjectManifest['gitignore'];
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operationId?: string;
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
  readonly skills: readonly ResolvedInstallSkill[];
  readonly storage?: ProjectMutationStorage;
  readonly targets: readonly TargetName[];
}

export interface UninstallProjectSkillsOptions {
  readonly confirmed?: boolean;
  readonly discardLocal?: boolean;
  readonly dryRun?: boolean;
  readonly operationId?: string;
  readonly projectRoot: string;
  readonly skillIds: readonly string[];
  readonly storage?: ProjectMutationStorage;
}

export type ResolvedAdoptSkill = Pick<
  CatalogSkillRecord,
  'compatibleAgents' | 'digest' | 'id' | 'name' | 'rootPath'
>;

export interface AdoptProjectSkillOptions {
  readonly dryRun?: boolean;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly operationId?: string;
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
  readonly skill: ResolvedAdoptSkill;
  readonly storage?: ProjectMutationStorage;
  readonly target: TargetName;
}

export interface AdoptProjectPlan {
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly libraryRevision: string;
  readonly operation: 'adopt';
  readonly projectRoot: string;
  readonly skill: {
    readonly destination: string;
    readonly digest: string;
    readonly id: string;
    readonly target: string;
  };
  readonly state: ProjectStatePlan;
  readonly writes: readonly string[];
}

interface ProjectStateSnapshot {
  readonly lock: ProjectLock | undefined;
  readonly manifest: ProjectManifest | undefined;
}

interface InstallMutation {
  readonly destination: string;
  readonly destinationRelative: string;
  readonly skill: ResolvedInstallSkill;
  readonly target: string;
}

interface InstallBuild {
  readonly gitignore: GitignoreUpdate;
  readonly mutations: readonly InstallMutation[];
  readonly nextLock: ProjectLock;
  readonly nextManifest: ProjectManifest;
  readonly plan: InstallPlan;
}

interface InspectedProjection {
  readonly destination: string;
  readonly destinationRelative: string;
  readonly exists: boolean;
  readonly locallyModified: boolean;
  readonly target: string;
}

interface UninstallBuild {
  readonly backupEntries: readonly { readonly path: string; readonly relativePath: string }[];
  readonly gitignore: GitignoreUpdate;
  readonly nextLock: ProjectLock;
  readonly nextManifest: ProjectManifest;
  readonly plan: UninstallPlan;
  readonly removals: readonly InspectedProjection[];
}

interface AdoptBuild {
  readonly backupEntries: readonly { readonly path: string; readonly relativePath: string }[];
  readonly nextLock: ProjectLock;
  readonly nextManifest: ProjectManifest;
  readonly plan: AdoptProjectPlan;
}

function projectError(
  code: string,
  message: string,
  exitCode: (typeof EXIT_CODES)[keyof typeof EXIT_CODES],
  details?: Readonly<Record<string, unknown>>,
): SkillSyncError {
  return new SkillSyncError(code, message, exitCode, details);
}

function portableFromRoot(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).split(sep).join('/');
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertUniqueSelection(selection: readonly { readonly id: string }[]): void {
  if (selection.length === 0) {
    throw projectError(
      'MISSING_SKILL_SELECTION',
      'At least one pre-resolved skill must be supplied.',
      EXIT_CODES.usage,
    );
  }
  const ids = selection.map((skill) => skill.id);
  if (new Set(ids).size !== ids.length) {
    throw projectError(
      'DUPLICATE_SKILL_SELECTION',
      'The pre-resolved skill selection contains duplicate qualified IDs.',
      EXIT_CODES.validation,
      { ids },
    );
  }
}

async function readState(projectRoot: string): Promise<ProjectStateSnapshot> {
  const [manifest, lock] = await Promise.all([
    readProjectManifest(projectRoot),
    readProjectLock(projectRoot),
  ]);
  if ((manifest === undefined) !== (lock === undefined)) {
    throw projectError(
      'INCOMPLETE_PROJECT_STATE',
      `Both ${PROJECT_MANIFEST_FILENAME} and ${PROJECT_LOCK_FILENAME} must be present together.`,
      EXIT_CODES.validation,
    );
  }
  if (manifest !== undefined && lock !== undefined) {
    assertProjectStatePair(manifest, lock);
    const lockedIds = new Set(lock.skills.map((skill) => skill.id));
    const missingLockEntries = manifest.skills
      .map((skill) => skill.id)
      .filter((id) => !lockedIds.has(id));
    if (missingLockEntries.length > 0 || manifest.skills.length !== lock.skills.length) {
      throw projectError(
        'INCOMPLETE_PROJECT_STATE',
        'Every desired skill must have exactly one resolved lock entry.',
        EXIT_CODES.validation,
        { missingLockEntries },
      );
    }
  }
  return { lock, manifest };
}

function assertLibraryIdentity(snapshot: ProjectStateSnapshot, identity: string): void {
  libraryIdentitySchema.parse(identity);
  const configuredIdentity = snapshot.manifest?.library.identity;
  if (configuredIdentity !== undefined && configuredIdentity !== identity) {
    throw projectError(
      'PROJECT_LIBRARY_MISMATCH',
      `This project is already connected to library ${configuredIdentity}.`,
      EXIT_CODES.validation,
      { configuredIdentity, requestedIdentity: identity },
    );
  }
}

async function inspectManagedProjection(
  projectRoot: string,
  projection: { readonly destination: string; readonly digest: string; readonly target: string },
): Promise<InspectedProjection> {
  await resolveContainedProjectPath(projectRoot, projection.destination);
  const destination = join(projectRoot, ...projection.destination.split('/'));
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        destination,
        destinationRelative: projection.destination,
        exists: false,
        locallyModified: false,
        target: projection.target,
      };
    }
    throw error;
  }

  try {
    const digest = await sha256TreeDigest(destination, { rejectNestedSkillRoots: true });
    return {
      destination,
      destinationRelative: projection.destination,
      exists: true,
      locallyModified: digest !== projection.digest,
      target: projection.target,
    };
  } catch {
    return {
      destination,
      destinationRelative: projection.destination,
      exists: true,
      locallyModified: true,
      target: projection.target,
    };
  }
}

async function assertInstallableTrackedSkill(
  skill: ResolvedInstallSkill,
  desired: DesiredSkill,
  resolved: ResolvedSkill | undefined,
  projectRoot: string,
): Promise<void> {
  if (resolved === undefined) {
    throw projectError(
      'INCOMPLETE_SKILL_STATE',
      `Tracked skill ${skill.id} has no lock entry.`,
      EXIT_CODES.validation,
    );
  }
  if (resolved.canonicalDigest !== skill.digest) {
    throw projectError(
      'INSTALL_REQUIRES_UPDATE',
      `${skill.id} is already tracked at a different library digest; use update or sync.`,
      EXIT_CODES.conflict,
      { id: skill.id },
    );
  }

  const desiredProjectionKeys = desired.projections.map(
    (projection) => `${projection.target}\0${projection.destination}`,
  );
  const resolvedProjectionKeys = resolved.projections.map(
    (projection) => `${projection.target}\0${projection.destination}`,
  );
  if (desiredProjectionKeys.join('\n') !== resolvedProjectionKeys.join('\n')) {
    throw projectError(
      'INCOMPLETE_SKILL_STATE',
      `Manifest and lock projections differ for ${skill.id}.`,
      EXIT_CODES.validation,
    );
  }

  const inspected = await Promise.all(
    resolved.projections.map((projection) => inspectManagedProjection(projectRoot, projection)),
  );
  const missing = inspected.filter((projection) => !projection.exists);
  const modified = inspected.filter((projection) => projection.locallyModified);
  if (missing.length > 0 || modified.length > 0) {
    throw projectError(
      modified.length > 0 ? 'LOCAL_MODIFICATIONS_REFUSED' : 'MISSING_MANAGED_DESTINATION',
      modified.length > 0
        ? `${skill.id} has local changes; install will not overwrite them.`
        : `${skill.id} has a missing managed copy; use sync to restore it.`,
      EXIT_CODES.conflict,
      {
        id: skill.id,
        missingTargets: missing.map((projection) => projection.target),
        modifiedTargets: modified.map((projection) => projection.target),
      },
    );
  }
}

async function validateResolvedSource(skill: ResolvedInstallSkill): Promise<void> {
  const tree = await inspectRegularFileTree(skill.rootPath, { rejectNestedSkillRoots: true });
  if (tree.digest !== skill.digest) {
    throw projectError(
      'LIBRARY_SKILL_CHANGED',
      `${skill.id} changed after catalog selection; refresh the library revision and retry.`,
      EXIT_CODES.validation,
      { id: skill.id },
    );
  }
}

function trackedDestinations(manifest: ProjectManifest | undefined): readonly {
  readonly skillId: string;
  readonly target: string;
  readonly path: string;
}[] {
  return (
    manifest?.skills.flatMap((skill) =>
      skill.projections.map((projection) => ({
        path: projection.destination,
        skillId: skill.id,
        target: projection.target,
      })),
    ) ?? []
  );
}

function projectionPlanMap(plans: readonly ProjectionPlan[]): ReadonlyMap<string, ProjectionPlan> {
  return new Map(plans.map((plan) => [`${plan.skillId}\0${plan.target}`, plan]));
}

function stateChanged(current: unknown, next: unknown): boolean {
  return current === undefined || stableJsonStringify(current) !== stableJsonStringify(next);
}

function managedDestinations(manifest: ProjectManifest): readonly string[] {
  return manifest.gitignore === 'managed'
    ? uniqueSorted(
        manifest.skills.flatMap((skill) =>
          skill.projections.map((projection) => projection.destination),
        ),
      )
    : [];
}

async function buildInstall(options: InstallProjectSkillsOptions): Promise<InstallBuild> {
  assertUniqueSelection(options.skills);
  const targets = uniqueSorted(options.targets);
  if (targets.length === 0) {
    throw projectError(
      'MISSING_TARGET_SELECTION',
      'At least one pre-resolved target must be supplied.',
      EXIT_CODES.usage,
    );
  }

  const projectRoot = await realpath(options.projectRoot);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.libraryRevision)) {
    throw projectError(
      'INVALID_LIBRARY_REVISION',
      'The pre-resolved library revision must be a full Git object ID.',
      EXIT_CODES.validation,
    );
  }
  const snapshot = await readState(projectRoot);
  assertLibraryIdentity(snapshot, options.libraryIdentity);
  await Promise.all(options.skills.map((skill) => validateResolvedSource(skill)));

  const preflight = await preflightTargets({
    projectRoot,
    registry: options.registry ?? new TargetRegistry(),
    skills: options.skills.map((skill) => ({ id: skill.id, leafName: skill.name })),
    targets,
    trackedDestinations: trackedDestinations(snapshot.manifest),
  });
  if (preflight.issues.length > 0) {
    const conflict = preflight.issues.some((issue) =>
      ['DESTINATION_COLLISION', 'UNMANAGED_COLLISION'].includes(issue.code),
    );
    throw projectError(
      'TARGET_PREFLIGHT_FAILED',
      preflight.issues.map((issue) => issue.message).join('\n'),
      conflict ? EXIT_CODES.conflict : EXIT_CODES.validation,
      { issues: preflight.issues },
    );
  }

  const trackedOwners = new Map(
    trackedDestinations(snapshot.manifest).map((entry) => [
      `${entry.target}\0${entry.path}`,
      entry.skillId,
    ]),
  );
  const ownedPathConflicts = preflight.plans.flatMap((plan) => {
    const path = portableFromRoot(projectRoot, plan.destination);
    const owner = trackedOwners.get(`${plan.target}\0${path}`);
    return owner === undefined || owner === plan.skillId
      ? []
      : [{ id: plan.skillId, owner, path, target: plan.target }];
  });
  if (ownedPathConflicts.length > 0) {
    throw projectError(
      'TRACKED_DESTINATION_COLLISION',
      ownedPathConflicts
        .map(
          (conflict) =>
            `${conflict.id} and managed skill ${conflict.owner} both map to ${conflict.path}.`,
        )
        .join('\n'),
      EXIT_CODES.conflict,
      { conflicts: ownedPathConflicts },
    );
  }

  const desiredById = new Map(snapshot.manifest?.skills.map((skill) => [skill.id, skill]) ?? []);
  const resolvedById = new Map(snapshot.lock?.skills.map((skill) => [skill.id, skill]) ?? []);
  for (const skill of options.skills) {
    const desired = desiredById.get(skill.id);
    if (desired !== undefined) {
      await assertInstallableTrackedSkill(skill, desired, resolvedById.get(skill.id), projectRoot);
    }
  }

  const plansBySkillAndTarget = projectionPlanMap(preflight.plans);
  const nextDesiredById = new Map(desiredById);
  const nextResolvedById = new Map(resolvedById);
  const mutations: InstallMutation[] = [];
  const skillPlans: InstallSkillPlan[] = [];

  for (const skill of [...options.skills].sort((left, right) => left.id.localeCompare(right.id))) {
    const currentDesired = desiredById.get(skill.id);
    const currentResolved = resolvedById.get(skill.id);
    const desiredProjections = [...(currentDesired?.projections ?? [])];
    const resolvedProjections = [...(currentResolved?.projections ?? [])];
    const requestedPlans: PlannedProjection[] = [];
    let expanded = false;

    for (const target of targets) {
      const plan = plansBySkillAndTarget.get(`${skill.id}\0${target}`);
      if (plan === undefined) {
        throw projectError(
          'MISSING_PREFLIGHT_PLAN',
          `No preflight projection was produced for ${skill.id} on ${target}.`,
          EXIT_CODES.validation,
        );
      }
      const relativeDestination = portableFromRoot(projectRoot, plan.destination);
      const existingProjection = desiredProjections.find(
        (projection) => projection.target === target,
      );
      if (
        existingProjection !== undefined &&
        existingProjection.destination !== relativeDestination
      ) {
        throw projectError(
          'TARGET_MAPPING_CHANGED',
          `Tracked destination for ${skill.id} on ${target} differs from the active adapter.`,
          EXIT_CODES.validation,
        );
      }
      const write = existingProjection === undefined;
      requestedPlans.push({ destination: relativeDestination, target, write });
      if (write) {
        expanded = currentDesired !== undefined;
        desiredProjections.push({ destination: relativeDestination, target });
        resolvedProjections.push({
          destination: relativeDestination,
          digest: skill.digest,
          target,
        });
        mutations.push({
          destination: plan.destination,
          destinationRelative: relativeDestination,
          skill,
          target,
        });
      }
    }

    nextDesiredById.set(skill.id, { id: skill.id, projections: desiredProjections });
    nextResolvedById.set(skill.id, {
      baseDigest: currentResolved?.baseDigest ?? skill.digest,
      canonicalDigest: skill.digest,
      id: skill.id,
      projections: resolvedProjections,
    });
    skillPlans.push({
      digest: skill.digest,
      id: skill.id,
      projections: requestedPlans,
      status:
        currentDesired === undefined
          ? 'install'
          : expanded
            ? 'expand-targets'
            : 'already-installed',
    });
  }

  const gitignorePolicy = options.gitignore ?? snapshot.manifest?.gitignore ?? 'unmanaged';
  const nextManifest = canonicalizeProjectManifest(
    projectManifestSchema.parse({
      gitignore: gitignorePolicy,
      library: { identity: options.libraryIdentity },
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      skills: [...nextDesiredById.values()],
    }),
  );
  const anySkillMutation = mutations.length > 0;
  const nextLock = canonicalizeProjectLock(
    projectLockSchema.parse({
      library: {
        identity: options.libraryIdentity,
        revision:
          snapshot.lock === undefined || anySkillMutation
            ? options.libraryRevision
            : snapshot.lock.library.revision,
      },
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      skills: [...nextResolvedById.values()],
    }),
  );
  const gitignore = await updateManagedGitignore({
    dryRun: true,
    managedDestinations: managedDestinations(nextManifest),
    projectRoot,
  });
  const manifestChanged = stateChanged(snapshot.manifest, nextManifest);
  const lockChanged = stateChanged(snapshot.lock, nextLock);
  const writes = uniqueSorted([
    ...mutations.map((mutation) => mutation.destinationRelative),
    ...(manifestChanged ? [PROJECT_MANIFEST_FILENAME] : []),
    ...(lockChanged ? [PROJECT_LOCK_FILENAME] : []),
    ...(gitignore.changed ? ['.gitignore'] : []),
  ]);

  return {
    gitignore,
    mutations,
    nextLock,
    nextManifest,
    plan: {
      applied: false,
      dryRun: options.dryRun === true,
      gitignore,
      libraryRevision: options.libraryRevision,
      operation: 'install',
      projectRoot,
      skills: skillPlans,
      state: { lockChanged, manifestChanged },
      writes,
    },
  };
}

async function writeStagedJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, stableJsonStringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
}

function requireStorage(storage: ProjectMutationStorage | undefined): ProjectMutationStorage {
  if (storage === undefined) {
    throw projectError(
      'MISSING_TRANSACTION_STORAGE',
      'Real project mutations require lock, journal, staging, and backup storage paths.',
      EXIT_CODES.usage,
    );
  }
  return storage;
}

export async function installProjectSkills(
  options: InstallProjectSkillsOptions,
): Promise<InstallPlan> {
  const initial = await buildInstall(options);
  if (options.dryRun === true || initial.plan.writes.length === 0) return initial.plan;

  const storage = requireStorage(options.storage);
  const operationId = options.operationId ?? `install-${randomUUID()}`;
  const advisoryLock = await acquireAdvisoryLock(storage.lockPath, { operationId });
  let stagingDirectory: string | undefined;
  try {
    const build = await buildInstall(options);
    if (build.plan.writes.length === 0) return build.plan;
    stagingDirectory = await createStagingDirectory(storage.stagingRoot, operationId);
    const stagedBySkill = new Map<string, string>();
    const replacements: AtomicReplacement[] = [];

    for (const mutation of build.mutations) {
      let staged = stagedBySkill.get(mutation.skill.id);
      if (staged === undefined) {
        staged = await stageRegularPath(
          mutation.skill.rootPath,
          stagingDirectory,
          `skills/${mutation.skill.id}`,
        );
        const stagedDigest = await sha256TreeDigest(staged, { rejectNestedSkillRoots: true });
        if (stagedDigest !== mutation.skill.digest) {
          throw projectError(
            'STAGED_DIGEST_MISMATCH',
            `Staged bytes for ${mutation.skill.id} do not match the selected canonical digest.`,
            EXIT_CODES.validation,
          );
        }
        stagedBySkill.set(mutation.skill.id, staged);
      }
      replacements.push({
        action: 'replace',
        destinationPath: mutation.destination,
        stagedPath: staged,
      });
    }

    if (build.plan.state.manifestChanged) {
      const path = join(stagingDirectory, PROJECT_MANIFEST_FILENAME);
      await writeStagedJson(path, build.nextManifest);
      replacements.push({
        action: 'replace',
        destinationPath: join(build.plan.projectRoot, PROJECT_MANIFEST_FILENAME),
        stagedPath: path,
      });
    }
    if (build.plan.state.lockChanged) {
      const path = join(stagingDirectory, PROJECT_LOCK_FILENAME);
      await writeStagedJson(path, build.nextLock);
      replacements.push({
        action: 'replace',
        destinationPath: join(build.plan.projectRoot, PROJECT_LOCK_FILENAME),
        stagedPath: path,
      });
    }
    if (build.gitignore.changed) {
      const path = join(stagingDirectory, 'gitignore');
      await writeFile(path, build.gitignore.after, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      replacements.push({
        action: 'replace',
        destinationPath: build.gitignore.path,
        stagedPath: path,
      });
    }

    await replacePathsAtomically({
      journalDirectory: storage.journalDirectory,
      kind: 'install',
      operationId,
      replacements,
      root: build.plan.projectRoot,
    });
    return { ...build.plan, applied: true };
  } finally {
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    await advisoryLock.release();
  }
}

async function buildAdopt(options: AdoptProjectSkillOptions): Promise<AdoptBuild> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.libraryRevision)) {
    throw projectError(
      'INVALID_LIBRARY_REVISION',
      'The pre-resolved library revision must be a full Git object ID.',
      EXIT_CODES.validation,
    );
  }
  if (!options.skill.compatibleAgents.includes(options.target)) {
    throw projectError(
      'INCOMPATIBLE_TARGET',
      `${options.skill.id} does not declare compatibility with ${options.target}.`,
      EXIT_CODES.validation,
      { id: options.skill.id, target: options.target },
    );
  }

  const projectRoot = await realpath(options.projectRoot);
  const registry = options.registry ?? new TargetRegistry();
  const adapter = registry.get(options.target);
  if (adapter === undefined) {
    throw projectError(
      'UNKNOWN_TARGET',
      `Unknown target: ${options.target}.`,
      EXIT_CODES.validation,
      { target: options.target },
    );
  }

  let destination: string;
  try {
    destination = await resolveContainedProjectPath(
      projectRoot,
      adapter.relativeDestination(options.skill.name).split(sep).join('/'),
    );
  } catch (error) {
    throw projectError(
      'UNSAFE_ADOPTION_DESTINATION',
      error instanceof Error ? error.message : 'The selected target destination is unsafe.',
      EXIT_CODES.validation,
      { target: options.target },
    );
  }
  const destinationRelative = portableFromRoot(projectRoot, destination);

  try {
    const information = await lstat(destination);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw projectError(
        'UNMANAGED_SKILL_INVALID',
        `The ${options.target} skill directory is not a regular directory: ${destinationRelative}.`,
        EXIT_CODES.validation,
        { path: destinationRelative, target: options.target },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw projectError(
        'UNMANAGED_SKILL_NOT_FOUND',
        `No unmanaged ${options.target} skill exists at ${destinationRelative}.`,
        EXIT_CODES.validation,
        { path: destinationRelative, target: options.target },
      );
    }
    throw error;
  }

  await validateResolvedSource(options.skill);
  const local = await validateSkillDirectory(destination, options.skill.name);
  if (!local.valid || local.skill === null) {
    throw projectError(
      'UNMANAGED_SKILL_INVALID',
      `The unmanaged ${options.target} skill at ${destinationRelative} is not valid: ${local.errors
        .map((issue) => issue.message)
        .join(' ')}`,
      EXIT_CODES.validation,
      { path: destinationRelative, target: options.target },
    );
  }
  if (local.skill.digest !== options.skill.digest) {
    throw projectError(
      'ADOPTION_DIGEST_MISMATCH',
      `${destinationRelative} does not exactly match canonical skill ${options.skill.id}; it was left unchanged.`,
      EXIT_CODES.conflict,
      { id: options.skill.id, path: destinationRelative, target: options.target },
    );
  }

  const snapshot = await readState(projectRoot);
  assertLibraryIdentity(snapshot, options.libraryIdentity);
  const desiredById = new Map(snapshot.manifest?.skills.map((skill) => [skill.id, skill]) ?? []);
  if (desiredById.has(options.skill.id)) {
    throw projectError(
      'SKILL_ALREADY_MANAGED',
      `${options.skill.id} is already managed in this project; use sync or update instead.`,
      EXIT_CODES.conflict,
      { id: options.skill.id },
    );
  }
  const existingOwner = trackedDestinations(snapshot.manifest).find(
    (entry) => entry.target === options.target && entry.path === destinationRelative,
  );
  if (existingOwner !== undefined) {
    throw projectError(
      'TRACKED_DESTINATION_COLLISION',
      `${destinationRelative} is already managed by ${existingOwner.skillId}.`,
      EXIT_CODES.conflict,
      { id: options.skill.id, owner: existingOwner.skillId, path: destinationRelative },
    );
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
          projections: [{ destination: destinationRelative, target: options.target }],
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
              destination: destinationRelative,
              digest: options.skill.digest,
              target: options.target,
            },
          ],
        },
      ],
    }),
  );
  const manifestChanged = stateChanged(snapshot.manifest, nextManifest);
  const lockChanged = stateChanged(snapshot.lock, nextLock);
  const backupEntries =
    snapshot.manifest === undefined
      ? []
      : [
          {
            path: join(projectRoot, PROJECT_MANIFEST_FILENAME),
            relativePath: PROJECT_MANIFEST_FILENAME,
          },
          { path: join(projectRoot, PROJECT_LOCK_FILENAME), relativePath: PROJECT_LOCK_FILENAME },
        ];
  return {
    backupEntries,
    nextLock,
    nextManifest,
    plan: {
      applied: false,
      dryRun: options.dryRun === true,
      libraryRevision: options.libraryRevision,
      operation: 'adopt',
      projectRoot,
      skill: {
        destination: destinationRelative,
        digest: options.skill.digest,
        id: options.skill.id,
        target: options.target,
      },
      state: { lockChanged, manifestChanged },
      writes: uniqueSorted([
        ...(manifestChanged ? [PROJECT_MANIFEST_FILENAME] : []),
        ...(lockChanged ? [PROJECT_LOCK_FILENAME] : []),
      ]),
    },
  };
}

/** Adopt an exact, validated unmanaged copy without replacing any target files. */
export async function adoptProjectSkill(
  options: AdoptProjectSkillOptions,
): Promise<AdoptProjectPlan> {
  const initial = await buildAdopt(options);
  if (options.dryRun === true || initial.plan.writes.length === 0) return initial.plan;

  const storage = requireStorage(options.storage);
  const operationId = options.operationId ?? `adopt-${randomUUID()}`;
  const advisoryLock = await acquireAdvisoryLock(storage.lockPath, { operationId });
  let stagingDirectory: string | undefined;
  try {
    const build = await buildAdopt(options);
    if (build.plan.writes.length === 0) return build.plan;
    if (build.backupEntries.length > 0) {
      await createRecoverableBackup({
        backupRoot: storage.backupRoot,
        entries: build.backupEntries,
        operationId,
        projectRoot: build.plan.projectRoot,
      });
    }
    stagingDirectory = await createStagingDirectory(storage.stagingRoot, operationId);
    const manifestPath = join(stagingDirectory, PROJECT_MANIFEST_FILENAME);
    const lockPath = join(stagingDirectory, PROJECT_LOCK_FILENAME);
    await writeStagedJson(manifestPath, build.nextManifest);
    await writeStagedJson(lockPath, build.nextLock);
    await replacePathsAtomically({
      journalDirectory: storage.journalDirectory,
      kind: 'adopt',
      operationId,
      replacements: [
        {
          action: 'replace',
          destinationPath: join(build.plan.projectRoot, PROJECT_MANIFEST_FILENAME),
          stagedPath: manifestPath,
        },
        {
          action: 'replace',
          destinationPath: join(build.plan.projectRoot, PROJECT_LOCK_FILENAME),
          stagedPath: lockPath,
        },
      ],
      root: build.plan.projectRoot,
    });
    return { ...build.plan, applied: true };
  } finally {
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    await advisoryLock.release();
  }
}

async function buildUninstall(options: UninstallProjectSkillsOptions): Promise<UninstallBuild> {
  const ids = uniqueSorted(options.skillIds);
  if (ids.length === 0) {
    throw projectError(
      'MISSING_SKILL_SELECTION',
      'At least one pre-resolved tracked skill ID must be supplied.',
      EXIT_CODES.usage,
    );
  }
  if (ids.length !== options.skillIds.length) {
    throw projectError(
      'DUPLICATE_SKILL_SELECTION',
      'The uninstall selection contains duplicate qualified IDs.',
      EXIT_CODES.validation,
    );
  }

  const projectRoot = await realpath(options.projectRoot);
  const snapshot = await readState(projectRoot);
  if (snapshot.manifest === undefined || snapshot.lock === undefined) {
    throw projectError(
      'PROJECT_NOT_INITIALIZED',
      'This project has no managed skill-sync installation state.',
      EXIT_CODES.validation,
    );
  }
  const desiredById = new Map(snapshot.manifest.skills.map((skill) => [skill.id, skill]));
  const resolvedById = new Map(snapshot.lock.skills.map((skill) => [skill.id, skill]));
  const unknown = ids.filter((id) => !desiredById.has(id));
  if (unknown.length > 0) {
    throw projectError(
      'SKILL_NOT_MANAGED',
      `Uninstall only removes managed skills; not tracked: ${unknown.join(', ')}.`,
      EXIT_CODES.validation,
      { ids: unknown },
    );
  }

  const skillPlans: UninstallSkillPlan[] = [];
  const removals: InspectedProjection[] = [];
  for (const id of ids) {
    const desired = desiredById.get(id);
    const resolved = resolvedById.get(id);
    if (desired === undefined || resolved === undefined) {
      throw projectError(
        'INCOMPLETE_SKILL_STATE',
        `Tracked skill ${id} is missing desired or resolved state.`,
        EXIT_CODES.validation,
      );
    }
    const inspected = await Promise.all(
      resolved.projections.map((projection) => inspectManagedProjection(projectRoot, projection)),
    );
    removals.push(...inspected);
    skillPlans.push({
      id,
      locallyModified: inspected.some((projection) => projection.locallyModified),
      projections: inspected.map((projection) => ({
        destination: projection.destinationRelative,
        target: projection.target,
        write: projection.exists,
      })),
    });
  }

  const modified = skillPlans.filter((skill) => skill.locallyModified);
  if (modified.length > 0 && options.discardLocal !== true) {
    throw projectError(
      'LOCAL_MODIFICATIONS_REFUSED',
      `Refusing to uninstall locally modified skills: ${modified.map((skill) => skill.id).join(', ')}.`,
      EXIT_CODES.conflict,
      { ids: modified.map((skill) => skill.id) },
    );
  }
  if (modified.length > 0 && options.dryRun !== true && options.confirmed !== true) {
    throw projectError(
      'DESTRUCTIVE_CONFIRMATION_REQUIRED',
      'Discarding local skill changes requires explicit destructive confirmation.',
      EXIT_CODES.usage,
      { ids: modified.map((skill) => skill.id) },
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
  const gitignore = await updateManagedGitignore({
    dryRun: true,
    managedDestinations: managedDestinations(nextManifest),
    projectRoot,
  });
  const manifestChanged = stateChanged(snapshot.manifest, nextManifest);
  const lockChanged = stateChanged(snapshot.lock, nextLock);
  const backupRelativePaths =
    modified.length === 0
      ? []
      : uniqueSorted([
          ...removals
            .filter((projection) => projection.exists)
            .map((projection) => projection.destinationRelative),
          PROJECT_MANIFEST_FILENAME,
          PROJECT_LOCK_FILENAME,
        ]);
  const backupEntries = backupRelativePaths.map((relativePath) => ({
    path: join(projectRoot, ...relativePath.split('/')),
    relativePath,
  }));
  const writes = uniqueSorted([
    ...removals
      .filter((projection) => projection.exists)
      .map((projection) => projection.destinationRelative),
    ...(manifestChanged ? [PROJECT_MANIFEST_FILENAME] : []),
    ...(lockChanged ? [PROJECT_LOCK_FILENAME] : []),
    ...(gitignore.changed ? ['.gitignore'] : []),
  ]);

  return {
    backupEntries,
    gitignore,
    nextLock,
    nextManifest,
    plan: {
      applied: false,
      backup: { paths: backupRelativePaths, required: backupRelativePaths.length > 0 },
      dryRun: options.dryRun === true,
      gitignore,
      libraryRevision: snapshot.lock.library.revision,
      operation: 'uninstall',
      projectRoot,
      skills: skillPlans,
      state: { lockChanged, manifestChanged },
      writes,
    },
    removals,
  };
}

export async function uninstallProjectSkills(
  options: UninstallProjectSkillsOptions,
): Promise<UninstallPlan> {
  const initial = await buildUninstall(options);
  if (options.dryRun === true) return initial.plan;

  const storage = requireStorage(options.storage);
  const operationId = options.operationId ?? `uninstall-${randomUUID()}`;
  const advisoryLock = await acquireAdvisoryLock(storage.lockPath, { operationId });
  let stagingDirectory: string | undefined;
  try {
    const build = await buildUninstall(options);
    if (build.plan.backup.required) {
      await createRecoverableBackup({
        backupRoot: storage.backupRoot,
        entries: build.backupEntries,
        operationId,
        projectRoot: build.plan.projectRoot,
      });
    }

    stagingDirectory = await createStagingDirectory(storage.stagingRoot, operationId);
    const replacements: AtomicReplacement[] = build.removals
      .filter((projection) => projection.exists)
      .map((projection) => ({
        action: 'remove',
        destinationPath: projection.destination,
      }));
    const manifestPath = join(stagingDirectory, PROJECT_MANIFEST_FILENAME);
    const lockPath = join(stagingDirectory, PROJECT_LOCK_FILENAME);
    await writeStagedJson(manifestPath, build.nextManifest);
    await writeStagedJson(lockPath, build.nextLock);
    replacements.push(
      {
        action: 'replace',
        destinationPath: join(build.plan.projectRoot, PROJECT_MANIFEST_FILENAME),
        stagedPath: manifestPath,
      },
      {
        action: 'replace',
        destinationPath: join(build.plan.projectRoot, PROJECT_LOCK_FILENAME),
        stagedPath: lockPath,
      },
    );
    if (build.gitignore.changed) {
      const path = join(stagingDirectory, 'gitignore');
      await writeFile(path, build.gitignore.after, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      replacements.push({
        action: 'replace',
        destinationPath: build.gitignore.path,
        stagedPath: path,
      });
    }

    await replacePathsAtomically({
      journalDirectory: storage.journalDirectory,
      kind: 'uninstall',
      operationId,
      replacements,
      root: build.plan.projectRoot,
    });
    return { ...build.plan, applied: true };
  } finally {
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    await advisoryLock.release();
  }
}
