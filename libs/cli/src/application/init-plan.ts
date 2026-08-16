import { createHash } from 'node:crypto';

import { stableJsonStringify } from '../infrastructure/stable-json.js';

export const INIT_PLAN_FINGERPRINT_PATTERN = /^init-v1-[a-f0-9]{64}$/u;
export const INIT_CONFIGURATION_FINGERPRINT_PATTERN = /^config-v1-[a-f0-9]{64}$/u;

export type LibraryInitPlanAction = 'connect' | 'create' | 'initialize-empty';

export interface LibraryInitPlanEffects {
  readonly cache: 'refresh';
  readonly configuration: 'none' | 'write';
  readonly githubRepository: 'create' | 'none';
  readonly remoteLibrary: 'initialize' | 'none';
}

export interface InitPlanFingerprintInput {
  readonly action: LibraryInitPlanAction;
  readonly branch: string;
  readonly configuration: {
    readonly after: unknown;
    readonly before: unknown;
  };
  readonly effects: LibraryInitPlanEffects;
  readonly remote: {
    readonly cloneUrl: string;
    readonly identity: string;
    readonly transport: string;
  };
  readonly repository: string | null;
  readonly revision: string | null;
  readonly validation: {
    readonly groups: number;
    readonly skills: number;
  } | null;
  readonly visibility: string | null;
}

/** Bind the complete pre-setup configuration without exposing it in plan output. */
export function initConfigurationFingerprint(configuration: unknown): string {
  const digest = createHash('sha256')
    .update('skill-sync-init-config-v1\0')
    .update(
      stableJsonStringify(
        configuration === undefined
          ? { state: 'absent' }
          : { state: 'present', value: configuration },
      ),
    )
    .digest('hex');
  return `config-v1-${digest}`;
}

/** Bind every reviewed setup input and observed remote/configuration state to one plan. */
export function initPlanFingerprint(input: InitPlanFingerprintInput): string {
  const digest = createHash('sha256')
    .update('skill-sync-init-v1\0')
    .update(
      stableJsonStringify({
        action: input.action,
        branch: input.branch,
        configuration: input.configuration,
        effects: input.effects,
        remote: input.remote,
        repository: input.repository,
        revision: input.revision,
        validation: input.validation,
        version: 'init-v1',
        visibility: input.visibility,
      }),
    )
    .digest('hex');
  return `init-v1-${digest}`;
}
