import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

export interface UpgradeConfig {
  owner: string;
  repo: string;
  currentVersion: string;
}

export type LatestReleaseResult = { ok: true; release: GitHubRelease } | { ok: false; reason: string };

export type DownloadResult = { ok: true; child: ChildProcess | FakeChildProcess } | { ok: false; reason: string };

export interface FakeChildProcess {
  unref(): void;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: 'inherit'; detached: boolean },
) => ChildProcess | FakeChildProcess;

export type DownloadLike = (url: string) => Promise<Uint8Array>;

const SCRIPT_RUNTIMES = new Set(['bun', 'node', 'tsx']);

function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '').split('+')[0] ?? '';
}

function parseVersion(version: string): number[] {
  return normalizeVersion(version)
    .split('.')
    .map((part) => {
      const [numeric] = part.split('-', 1);
      return Number.parseInt(numeric ?? part, 10);
    })
    .filter((num) => !Number.isNaN(num));
}

/**
 * Compare two semantic version strings. Pre-release and build metadata are
 * ignored; comparison stops at the first differing numeric segment.
 */
export function isUpgradeAvailable(runningVersion: string, latestVersion: string): boolean {
  const running = parseVersion(runningVersion);
  const latest = parseVersion(latestVersion);

  const maxLength = Math.max(running.length, latest.length);
  for (let i = 0; i < maxLength; i++) {
    const left = running[i] ?? 0;
    const right = latest[i] ?? 0;
    if (right > left) return true;
    if (right < left) return false;
  }

  return false;
}

function normalizeName(name: string): string {
  return path.basename(name).toLowerCase();
}

function platformToken(platform: string): string {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return platform.toLowerCase();
}

function archToken(arch: string): string {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  if (arch === 'ia32') return 'ia32';
  return arch.toLowerCase();
}

/**
 * Select the release asset that matches the requested platform and architecture.
 * Asset names are expected to contain the platform and arch tokens, e.g.
 * `afk-linux-x64`, `afk-darwin-arm64`.
 */
export function selectAsset(
  assets: GitHubReleaseAsset[],
  platform = process.platform,
  arch = process.arch,
): GitHubReleaseAsset | undefined {
  const platformMatch = platformToken(platform);
  const archMatch = archToken(arch);

  return assets.find((asset) => {
    const name = normalizeName(asset.name);
    return name.includes(platformMatch) && name.includes(archMatch);
  });
}

async function defaultDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function defaultSpawn(command: string, args: string[], options: { stdio: 'inherit'; detached: boolean }): ChildProcess {
  return spawn(command, args, options);
}

/**
 * Detect whether the current process is running a TypeScript/JavaScript source
 * entry point (e.g. `bun src/bin.ts`). When true, the binary should not be
 * overwritten.
 */
export function isRunningFromSource(argv: string[] = process.argv): boolean {
  const runtime = path.basename(argv[0] ?? '');
  if (!SCRIPT_RUNTIMES.has(runtime)) return false;
  return argv.slice(1).some((arg) => arg.endsWith('.ts') || arg.endsWith('.js'));
}

/**
 * Detect whether the process is attached to an interactive terminal. When
 * false, upgrade prompts must be skipped and a notice should be printed.
 */
export function isInteractive(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): boolean {
  return !!stdin.isTTY && !!stdout.isTTY;
}

function formatReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch the latest GitHub Release for the configured repository. Network and
 * API errors are caught and surfaced as a "continue without upgrade" outcome.
 */
export async function fetchLatestRelease(
  config: Pick<UpgradeConfig, 'owner' | 'repo'>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LatestReleaseResult> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/releases/latest`;

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'afk-upgrader',
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: `GitHub API returned ${response.status} ${response.statusText}`,
      };
    }

    const release = (await response.json()) as GitHubRelease;
    return {
      ok: true,
      release: {
        tag_name: release.tag_name,
        assets: release.assets ?? [],
      },
    };
  } catch (error) {
    return { ok: false, reason: formatReason(error) };
  }
}

/**
 * Download a release asset to a temporary path next to the target binary, make
 * it executable, atomically rename it over the target, and re-execute the
 * original command. When running from source the replacement is skipped.
 */
export async function downloadAndReplace(
  asset: GitHubReleaseAsset,
  targetPath: string,
  argv: string[] = process.argv,
  options: { download?: DownloadLike; spawn?: SpawnLike } = {},
): Promise<DownloadResult> {
  if (isRunningFromSource(argv)) {
    return { ok: false, reason: 'Running from source; skipping binary replacement.' };
  }

  const download = options.download ?? defaultDownload;
  const spawnImpl = options.spawn ?? defaultSpawn;

  try {
    const data = await download(asset.browser_download_url);
    const targetDir = path.dirname(targetPath);
    const tempPath = path.join(targetDir, `.${path.basename(targetPath)}.upgrade-${randomUUID()}`);

    await writeFile(tempPath, data, { mode: 0o755 });
    await rename(tempPath, targetPath);

    const child = spawnImpl(targetPath, argv.slice(1), { stdio: 'inherit', detached: true });
    child.unref();
    return { ok: true, child };
  } catch (error) {
    return { ok: false, reason: formatReason(error) };
  }
}

/**
 * Format a one-line notice for non-interactive environments.
 */
export function formatUpgradeNotice(currentVersion: string, latestVersion: string): string {
  return `afk ${currentVersion} → ${latestVersion} available; run \`afk\` interactively to upgrade.`;
}
