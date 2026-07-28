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

export interface TuiDashboard {
  readonly errors: readonly string[];
  readonly inventory: readonly TuiInventorySkill[];
  readonly inventoryIssues: readonly string[];
  readonly managed: readonly TuiManagedSkill[];
  readonly scope: 'global' | 'project';
  readonly skills: readonly TuiSkill[];
}

export interface TuiActionPort {
  adopt(id: string, target: string): Promise<CommandResult<unknown>>;
  install(ids: readonly string[], targets: readonly string[]): Promise<CommandResult<unknown>>;
  load(): Promise<TuiDashboard>;
  sync(discardLocal: boolean): Promise<CommandResult<unknown>>;
}
