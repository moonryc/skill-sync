import { describe, expect, it } from 'vitest';

import {
  ReleaseManagementService,
  type CliPackageMetadata,
  type NpmPackageRegistry,
  type NpmPackageUpdater,
} from '../../src/application/release-management.js';
import { NpmRegistryClient } from '../../src/infrastructure/npm-registry.js';
import {
  nodeNpmProcessRunner,
  NpmGlobalPackageUpdater,
  type NpmProcessRunner,
} from '../../src/infrastructure/npm-updater.js';

const metadata: CliPackageMetadata = { name: '@moonryc/skill-sync', version: '0.9.0' };

function registry(latest: string): NpmPackageRegistry {
  return { latestVersion: () => Promise.resolve(latest) };
}

function updater(): NpmPackageUpdater {
  return { installLatest: () => Promise.resolve() };
}

describe('release management', () => {
  it('uses semantic-version precedence to identify an available stable update', async () => {
    const service = new ReleaseManagementService(metadata, registry('0.10.0'), updater());

    await expect(service.availableUpdate()).resolves.toEqual({
      availableVersion: '0.10.0',
      installedVersion: '0.9.0',
    });
  });

  it.each(['0.9.0', '0.8.0', 'not-a-version', '1.0.0-next.1'])(
    'does not report %s as an available stable update',
    async (latest) => {
      const service = new ReleaseManagementService(metadata, registry(latest), updater());

      await expect(service.availableUpdate()).resolves.toBeUndefined();
    },
  );

  it('silently ignores registry failures', async () => {
    const service = new ReleaseManagementService(
      metadata,
      { latestVersion: () => Promise.reject(new Error('network unavailable')) },
      updater(),
    );

    await expect(service.availableUpdate()).resolves.toBeUndefined();
  });

  it('silently ignores timed-out registry lookups', async () => {
    const service = new ReleaseManagementService(
      metadata,
      { latestVersion: () => Promise.reject(new Error('The operation timed out.')) },
      updater(),
    );

    await expect(service.availableUpdate()).resolves.toBeUndefined();
  });

  it('runs an explicit self-update for the published package', async () => {
    const installed: string[] = [];
    const service = new ReleaseManagementService(metadata, registry('1.0.0'), {
      installLatest: (packageName) => {
        installed.push(packageName);
        return Promise.resolve();
      },
    });

    await expect(service.selfUpdate()).resolves.toEqual({
      packageName: '@moonryc/skill-sync',
      requestedVersion: 'latest',
    });
    expect(installed).toEqual(['@moonryc/skill-sync']);
  });

  it('returns a sanitized, actionable failure when self-update cannot run', async () => {
    const service = new ReleaseManagementService(metadata, registry('1.0.0'), {
      installLatest: () => Promise.reject(new Error('token=top-secret')),
    });

    await expect(service.selfUpdate()).rejects.toMatchObject({
      code: 'CLI_UPDATE_FAILED',
      message: 'npm could not update the CLI: token=[REDACTED]',
    });
  });

  it('retrieves the latest dist-tag through the npm registry client with a timeout signal', async () => {
    let requestedUrl = '';
    let requestSignal: AbortSignal | undefined;
    const client = new NpmRegistryClient({
      fetch: (url, options) => {
        requestedUrl = url;
        requestSignal = options.signal;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ 'dist-tags': { latest: '1.2.3' } }),
        });
      },
      timeoutMs: 50,
    });

    await expect(client.latestVersion('@moonryc/skill-sync')).resolves.toBe('1.2.3');
    expect(requestedUrl).toBe('https://registry.npmjs.org/%40moonryc%2Fskill-sync');
    expect(requestSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects malformed registry metadata', async () => {
    const client = new NpmRegistryClient({
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    });

    await expect(client.latestVersion('@moonryc/skill-sync')).rejects.toThrow(
      'package release metadata',
    );
  });

  it('invokes npm without a shell and with an exact global latest argument', async () => {
    const calls: {
      readonly arguments_: readonly string[];
      readonly executable: string;
      readonly shell: false;
    }[] = [];
    const run: NpmProcessRunner = (executable, arguments_, options) => {
      calls.push({ arguments_, executable, shell: options.shell });
      return Promise.resolve();
    };
    const npm = new NpmGlobalPackageUpdater(run);

    await npm.installLatest('@moonryc/skill-sync');

    expect(calls).toEqual([
      {
        arguments_: ['install', '--global', '@moonryc/skill-sync@latest'],
        executable: 'npm',
        shell: false,
      },
    ]);
  });

  it('maps bounded shared-runner failures to the stable self-update error', async () => {
    await expect(
      nodeNpmProcessRunner(
        process.execPath,
        ['-e', "process.stderr.write('token=top-secret denied'); process.exit(9);"],
        { shell: false, timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({
      code: 'CLI_UPDATE_FAILED',
      message: 'npm could not update the CLI: token=[REDACTED] denied',
    });

    const timeoutError: unknown = await nodeNpmProcessRunner(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000);'],
      { shell: false, timeoutMs: 25 },
    ).catch((error: unknown) => error);
    expect(timeoutError).toMatchObject({ code: 'CLI_UPDATE_FAILED' });
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toContain('timeout');
  });
});
