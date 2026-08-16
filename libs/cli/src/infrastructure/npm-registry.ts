import type { NpmPackageRegistry } from '../application/release-management.js';

interface NpmRegistryResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type NpmRegistryFetch = (
  url: string,
  options: Readonly<{ headers: Readonly<Record<string, string>>; signal: AbortSignal }>,
) => Promise<NpmRegistryResponse>;

export interface NpmRegistryClientOptions {
  readonly fetch?: NpmRegistryFetch;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

async function nodeFetch(
  url: string,
  options: Readonly<{ headers: Readonly<Record<string, string>>; signal: AbortSignal }>,
): Promise<NpmRegistryResponse> {
  return await globalThis.fetch(url, options);
}

export class NpmRegistryClient implements NpmPackageRegistry {
  private readonly fetch: NpmRegistryFetch;
  private readonly timeoutMs: number;

  public constructor(options: NpmRegistryClientOptions = {}) {
    this.fetch = options.fetch ?? nodeFetch;
    this.timeoutMs = options.timeoutMs ?? 1_000;
  }

  public async latestVersion(packageName: string): Promise<string> {
    const response = await this.fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) throw new Error('The npm registry did not return a successful response.');
    const payload = await response.json();
    if (!isRecord(payload) || !isRecord(payload['dist-tags'])) {
      throw new Error('The npm registry did not return package release metadata.');
    }
    const latest = payload['dist-tags'].latest;
    if (typeof latest !== 'string' || latest.length === 0) {
      throw new Error('The npm registry did not return a latest package version.');
    }
    return latest;
  }
}
