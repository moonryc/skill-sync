import { gt, prerelease, valid } from 'semver';

import { EXIT_CODES, redactSecrets, SkillSyncError } from '../domain/result.js';

export interface CliPackageMetadata {
  readonly name: string;
  readonly version: string;
}

export interface NpmPackageRegistry {
  latestVersion(packageName: string): Promise<string>;
}

export interface NpmPackageUpdater {
  installLatest(packageName: string): Promise<void>;
}

export interface CliReleaseUpdate {
  readonly availableVersion: string;
  readonly installedVersion: string;
}

export interface CliSelfUpdateResult {
  readonly packageName: string;
  readonly requestedVersion: 'latest';
}

export interface CliReleaseManagement {
  availableUpdate(): Promise<CliReleaseUpdate | undefined>;
  selfUpdate(): Promise<CliSelfUpdateResult>;
}

export class ReleaseManagementService implements CliReleaseManagement {
  public constructor(
    private readonly metadata: CliPackageMetadata,
    private readonly registry: NpmPackageRegistry,
    private readonly updater: NpmPackageUpdater,
  ) {}

  public async availableUpdate(): Promise<CliReleaseUpdate | undefined> {
    try {
      const availableVersion = valid(await this.registry.latestVersion(this.metadata.name));
      const installedVersion = valid(this.metadata.version);
      if (
        availableVersion === null ||
        installedVersion === null ||
        prerelease(availableVersion) !== null ||
        !gt(availableVersion, installedVersion)
      ) {
        return undefined;
      }
      return { availableVersion, installedVersion };
    } catch {
      return undefined;
    }
  }

  public async selfUpdate(): Promise<CliSelfUpdateResult> {
    try {
      await this.updater.installLatest(this.metadata.name);
    } catch (error) {
      if (error instanceof SkillSyncError) throw error;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      throw new SkillSyncError(
        'CLI_UPDATE_FAILED',
        message.length === 0
          ? 'npm could not update the CLI.'
          : `npm could not update the CLI: ${message}`,
        EXIT_CODES.internal,
      );
    }
    return { packageName: this.metadata.name, requestedVersion: 'latest' };
  }
}
