import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

export interface ReleaseAsset {
  name: string;
  browserDownloadUrl: string;
}

export interface ReleaseInfo {
  tagName: string;
  version: string;
  assets: ReleaseAsset[];
}

export interface UpgradeCheckResult {
  action: 'continue' | 'restarted' | 'skipped';
  message?: string;
}

export interface UpgradeDependencies {
  fetchLatestRelease: () => Promise<ReleaseInfo | null>;
  prompt: (message: string) => Promise<boolean>;
  downloadAsset: (url: string, tempPath: string) => Promise<void>;
  replaceBinary: (tempPath: string, targetPath: string) => Promise<void>;
  reexec: (targetPath: string, argv: string[]) => Promise<never>;
}

export interface UpgradeContext {
  currentVersion: string;
  argv: string[];
  targetPath: string;
  isInteractive: boolean;
  isJson: boolean;
  isSourceMode: boolean;
}

export function parseSemver(version: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const clean = version.startsWith('v') ? version.slice(1) : version;
  const [core, ...prerelease] = clean.split('-');
  const [major, minor, patch] = core.split('.').map((part) => Number.parseInt(part, 10));
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
    patch: Number.isFinite(patch) ? patch : 0,
    prerelease: prerelease.flatMap((segment) => segment.split('.')).filter(Boolean),
  };
}

export function isUpgradeAvailable(currentVersion: string, latestVersion: string): boolean {
  if (currentVersion === latestVersion) return false;
  const current = parseSemver(currentVersion);
  const latest = parseSemver(latestVersion);

  if (latest.major !== current.major) return latest.major > current.major;
  if (latest.minor !== current.minor) return latest.minor > current.minor;
  if (latest.patch !== current.patch) return latest.patch > current.patch;

  // A version without prerelease identifiers is considered newer than one with them.
  if (current.prerelease.length && !latest.prerelease.length) return true;
  if (!current.prerelease.length && latest.prerelease.length) return false;

  // Both have prerelease identifiers; compare segment by segment.
  const length = Math.max(current.prerelease.length, latest.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = current.prerelease[index];
    const right = latest.prerelease[index];
    if (left === undefined) return true;
    if (right === undefined) return false;
    const leftNum = Number.parseInt(left, 10);
    const rightNum = Number.parseInt(right, 10);
    const bothNumeric = Number.isFinite(leftNum) && Number.isFinite(rightNum);
    if (bothNumeric) {
      if (leftNum !== rightNum) return leftNum < rightNum;
    } else {
      if (left !== right) return left.localeCompare(right) < 0;
    }
  }

  return false;
}

export function assetNameForPlatform(platform: string, arch: string): string {
  const platformSuffix = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
  const archSuffix = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch;
  return `afk-${platformSuffix}-${archSuffix}`;
}

export function selectAsset(platform: string, arch: string, assets: ReleaseAsset[]): ReleaseAsset | null {
  const expected = assetNameForPlatform(platform, arch);
  return assets.find((asset) => asset.name === expected) ?? null;
}

export async function defaultDownloadAsset(url: string, tempPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const body = response.body;
  if (!body) {
    throw new Error('Download response had no body');
  }
  const file = createWriteStream(tempPath);
  await finished(Readable.fromWeb(body as never).pipe(file));
}

export async function defaultReplaceBinary(tempPath: string, targetPath: string): Promise<void> {
  await chmod(tempPath, 0o755);
  await rename(tempPath, targetPath);
}

export function isSourceMode(targetPath: string): boolean {
  return targetPath.endsWith('.ts') || targetPath.endsWith('.js');
}

export async function checkForUpgrade(
  context: UpgradeContext,
  dependencies: UpgradeDependencies,
): Promise<UpgradeCheckResult> {
  const { currentVersion, argv, targetPath, isInteractive, isJson, isSourceMode: sourceMode } = context;

  try {
    const release = await dependencies.fetchLatestRelease();
    if (!release) {
      return { action: 'continue' };
    }

    if (!isUpgradeAvailable(currentVersion, release.version)) {
      return { action: 'continue' };
    }

    const asset = selectAsset(process.platform, process.arch, release.assets);
    if (!asset) {
      return { action: 'continue' };
    }

    const notice = `afk ${currentVersion} → ${release.version} available; run \`afk\` interactively to upgrade.`;

    if (!isInteractive || isJson) {
      return { action: 'skipped', message: notice };
    }

    if (sourceMode) {
      return {
        action: 'skipped',
        message: `afk ${currentVersion} → ${release.version} available; source-mode invocation cannot replace the running binary.`,
      };
    }

    const confirmed = await dependencies.prompt(
      `A new version of afk is available: ${release.version} (you have ${currentVersion})\n? Upgrade now?`,
    );
    if (!confirmed) {
      return { action: 'continue' };
    }

    const tempPath = `${targetPath}.download-${Date.now()}`;
    try {
      await dependencies.downloadAsset(asset.browserDownloadUrl, tempPath);
      await dependencies.replaceBinary(tempPath, targetPath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // Best-effort cleanup of partial download.
      }
      throw error;
    }

    await dependencies.reexec(targetPath, argv);
    return { action: 'restarted' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { action: 'continue', message: `Upgrade check failed: ${reason}` };
  }
}

export async function fetchLatestGitHubRelease(
  owner: string,
  repo: string,
  fetcher: typeof fetch = fetch,
): Promise<ReleaseInfo | null> {
  try {
    const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      tag_name?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const tagName = payload.tag_name ?? '';
    const version = tagName.startsWith('v') ? tagName.slice(1) : tagName;
    const assets = (payload.assets ?? [])
      .filter((asset) => typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
      .map((asset) => ({
        name: asset.name as string,
        browserDownloadUrl: asset.browser_download_url as string,
      }));
    return { tagName, version, assets };
  } catch {
    return null;
  }
}

export function resolveTargetPath(argv: string[]): string {
  // In a compiled binary invocation argv[0] is the binary path.
  // In `bun src/bin.ts` argv[0] is `bun` and argv[1] is the script path.
  if (argv[0]?.includes(path.sep) && !argv[0].includes('bun')) {
    return path.resolve(argv[0]);
  }
  return path.resolve(argv[1] ?? argv[0] ?? process.argv[1] ?? process.argv[0] ?? 'afk');
}

export async function defaultReexec(targetPath: string, argv: string[]): Promise<never> {
  const child = spawn(targetPath, argv.slice(2), {
    stdio: 'inherit',
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
  process.exit();
}
