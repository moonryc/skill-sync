import type { CommandResult } from '../../domain/result.js';

export interface TuiLaunchRequest {
  readonly implicit: boolean;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface TuiLauncher {
  launch(request: TuiLaunchRequest): Promise<void>;
}

export interface TuiSkill {
  readonly compatibleAgents: readonly string[];
  readonly description: string;
  readonly group: string | null;
  readonly id: string;
  readonly installationState: string;
  readonly name: string;
}

export interface TuiManagedSkill {
  readonly id: string;
  readonly state: string;
}

export interface TuiInventorySkill {
  readonly adoptable: boolean;
  readonly issues: readonly string[];
  readonly name: string;
  readonly path: string;
  readonly status: string;
  readonly target: string;
}

export type TuiTarget = 'claude' | 'codex';

export interface TuiDashboard {
  readonly defaultTargets: readonly TuiTarget[];
  readonly errors: readonly string[];
  readonly firstRun: boolean;
  readonly groups: readonly string[];
  readonly inventory: readonly TuiInventorySkill[];
  readonly inventoryIssues: readonly string[];
  readonly manageGitignore: boolean;
  readonly managed: readonly TuiManagedSkill[];
  readonly scope: 'global' | 'project';
  readonly skills: readonly TuiSkill[];
}

export interface TuiReleaseUpdate {
  readonly availableVersion: string;
  readonly installedVersion: string;
}

export type TuiDoctorCheckStatus = 'fail' | 'pass' | 'skipped' | 'warning';

export interface TuiDoctorIssue {
  readonly id: string;
  readonly message: string;
  readonly remediation: string;
  readonly scope: 'local' | 'remote';
  readonly status: Exclude<TuiDoctorCheckStatus, 'pass'>;
}

export interface TuiDoctorSummary {
  readonly counts: Readonly<Record<TuiDoctorCheckStatus, number>>;
  readonly issues: readonly TuiDoctorIssue[];
  readonly location?: string;
  readonly offline: boolean;
  readonly scope: 'global' | 'project';
}

export interface TuiInstallProjection {
  readonly destination: string;
  readonly target: string;
  readonly write: boolean;
}

export interface TuiInstallSkillPreview {
  readonly digest: string;
  readonly id: string;
  readonly projections: readonly TuiInstallProjection[];
  readonly status: string;
}

export type TuiInstallGitignorePreview =
  | {
      readonly applicable: false;
      readonly changed: false;
    }
  | {
      readonly after: string;
      readonly applicable: true;
      readonly before: string;
      readonly changed: boolean;
      readonly path: string;
    };

export interface TuiInstallPreview {
  readonly fingerprint: string;
  readonly freshness: string;
  readonly gitignore: TuiInstallGitignorePreview;
  readonly libraryRevision: string;
  readonly location: string;
  readonly scope: 'global' | 'project';
  readonly skills: readonly TuiInstallSkillPreview[];
  readonly stale: boolean;
  readonly state: {
    readonly lockChanged: boolean;
    readonly manifestChanged: boolean;
  };
  readonly writes: readonly string[];
}

export interface TuiLibrarySetupIntent {
  readonly kind: 'connect' | 'create';
  readonly value: string;
}

export interface TuiLibraryAddPreview {
  readonly changed: true;
  readonly digest: string;
  readonly dryRun: true;
  readonly id: string;
  readonly revision: string;
}

export interface TuiLibraryInitPlan {
  readonly action: 'connect' | 'create' | 'initialize-empty';
  readonly branch: string;
  readonly configurationChanged: boolean;
  readonly effects: {
    readonly cache: 'refresh';
    readonly configuration: 'none' | 'write';
    readonly githubRepository: 'create' | 'none';
    readonly remoteLibrary: 'initialize' | 'none';
  };
  readonly fingerprint: string;
  readonly remote: {
    readonly cloneUrl: string;
    readonly identity: string;
    readonly transport: 'https' | 'ssh';
  };
  readonly remoteState: 'available' | 'compatible' | 'empty';
  readonly repository: string | null;
  readonly revision: string | null;
  readonly validation: {
    readonly groups: number;
    readonly skills: number;
  } | null;
  readonly visibility: 'internal' | 'private' | 'public' | null;
}

export interface TuiActionPort {
  add(path: string, group: string): Promise<CommandResult<unknown>>;
  adopt(id: string, target: string): Promise<CommandResult<unknown>>;
  applyLibrarySetup(
    intent: TuiLibrarySetupIntent,
    expectedPlanFingerprint: string,
  ): Promise<CommandResult<unknown>>;
  checkForUpdate(): Promise<TuiReleaseUpdate | undefined>;
  diagnose(): Promise<CommandResult<TuiDoctorSummary>>;
  install(
    ids: readonly string[],
    targets: readonly string[],
    manageGitignore: boolean,
    expectedPlanFingerprint: string,
  ): Promise<CommandResult<unknown>>;
  load(): Promise<TuiDashboard>;
  previewLibrarySetup(intent: TuiLibrarySetupIntent): Promise<CommandResult<TuiLibraryInitPlan>>;
  previewInstall(
    ids: readonly string[],
    targets: readonly string[],
    manageGitignore: boolean,
  ): Promise<CommandResult<TuiInstallPreview>>;
  previewAdd(path: string, group: string): Promise<CommandResult<TuiLibraryAddPreview>>;
  sync(discardLocal: boolean): Promise<CommandResult<unknown>>;
}
