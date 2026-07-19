export type ReconciliationState =
  | 'current'
  | 'outdated'
  | 'locally-modified'
  | 'conflicted'
  | 'missing'
  | 'orphaned'
  | 'unmanaged-collision';

export interface DestinationDigestState {
  readonly target: string;
  readonly path: string;
  readonly digest?: string;
  readonly exists: boolean;
  readonly unmanagedCollision?: boolean;
}

export interface ReconciliationInput {
  readonly baseDigest: string;
  readonly libraryDigest: string | undefined;
  readonly destinations: readonly DestinationDigestState[];
}

export interface ReconciliationAssessment {
  readonly state: ReconciliationState;
  readonly localChanged: boolean;
  readonly remoteChanged: boolean;
  readonly missingTargets: readonly string[];
  readonly divergentTargets: readonly string[];
}

export function classifyReconciliation(input: ReconciliationInput): ReconciliationAssessment {
  const missingTargets = input.destinations
    .filter((destination) => !destination.exists)
    .map((destination) => destination.target)
    .sort();
  const existing = input.destinations.filter(
    (destination): destination is DestinationDigestState & { digest: string } =>
      destination.exists && destination.digest !== undefined,
  );
  const digestVariants = new Set(existing.map((destination) => destination.digest));
  const divergentTargets =
    digestVariants.size > 1
      ? existing.map((destination) => destination.target).sort()
      : ([] as string[]);
  const localChanged = existing.some((destination) => destination.digest !== input.baseDigest);
  const remoteChanged =
    input.libraryDigest !== undefined && input.libraryDigest !== input.baseDigest;

  let state: ReconciliationState;
  if (input.destinations.some((destination) => destination.unmanagedCollision === true)) {
    state = 'unmanaged-collision';
  } else if (input.libraryDigest === undefined) {
    state = 'orphaned';
  } else if (divergentTargets.length > 0 || (localChanged && remoteChanged)) {
    state = 'conflicted';
  } else if (localChanged) {
    state = 'locally-modified';
  } else if (missingTargets.length > 0) {
    state = 'missing';
  } else if (remoteChanged) {
    state = 'outdated';
  } else {
    state = 'current';
  }

  return { state, localChanged, remoteChanged, missingTargets, divergentTargets };
}
