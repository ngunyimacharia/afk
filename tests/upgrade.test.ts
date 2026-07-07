import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  downloadAndReplace,
  fetchLatestRelease,
  formatUpgradeNotice,
  type GitHubReleaseAsset,
  isInteractive,
  isRunningFromSource,
  isUpgradeAvailable,
  type SpawnLike,
  selectAsset,
} from '../src/upgrade.js';

const baseAssets: GitHubReleaseAsset[] = [
  { name: 'afk-linux-x64', browser_download_url: 'https://example.com/afk-linux-x64' },
  { name: 'afk-darwin-arm64', browser_download_url: 'https://example.com/afk-darwin-arm64' },
  { name: 'afk-darwin-x64', browser_download_url: 'https://example.com/afk-darwin-x64' },
];

test('isUpgradeAvailable returns true when latest is greater', () => {
  assert.equal(isUpgradeAvailable('0.0.1', '0.0.2'), true);
  assert.equal(isUpgradeAvailable('0.0.1', '0.1.0'), true);
  assert.equal(isUpgradeAvailable('0.0.1', '1.0.0'), true);
  assert.equal(isUpgradeAvailable('v0.0.1', '0.0.2'), true);
});

test('isUpgradeAvailable returns false for equal or lower versions', () => {
  assert.equal(isUpgradeAvailable('0.0.2', '0.0.2'), false);
  assert.equal(isUpgradeAvailable('0.0.3', '0.0.2'), false);
  assert.equal(isUpgradeAvailable('0.1.0', '0.0.9'), false);
  assert.equal(isUpgradeAvailable('0.0.2', 'v0.0.2'), false);
});

test('selectAsset returns the correct asset for supported platforms', () => {
  assert.equal(selectAsset(baseAssets, 'linux', 'x64')?.name, 'afk-linux-x64');
  assert.equal(selectAsset(baseAssets, 'darwin', 'arm64')?.name, 'afk-darwin-arm64');
  assert.equal(selectAsset(baseAssets, 'darwin', 'x64')?.name, 'afk-darwin-x64');
});

test('selectAsset returns undefined for unsupported or mismatched platforms', () => {
  assert.equal(selectAsset(baseAssets, 'win32', 'x64'), undefined);
  assert.equal(selectAsset(baseAssets, 'linux', 'arm64'), undefined);
  assert.equal(selectAsset([], 'linux', 'x64'), undefined);
});

test('isRunningFromSource detects bun/node/tsx source invocations', () => {
  assert.equal(isRunningFromSource(['bun', 'src/bin.ts']), true);
  assert.equal(isRunningFromSource(['bun', 'src/bin.js']), true);
  assert.equal(isRunningFromSource(['node', 'dist/bin.js']), true);
  assert.equal(isRunningFromSource(['tsx', 'src/bin.ts']), true);
  assert.equal(isRunningFromSource(['/usr/local/bin/afk']), false);
  assert.equal(isRunningFromSource(['/usr/local/bin/afk', 'status']), false);
});

test('isInteractive requires both stdin and stdout to be TTY', () => {
  assert.equal(isInteractive({ isTTY: true } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream), true);
  assert.equal(isInteractive({ isTTY: false } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream), false);
  assert.equal(isInteractive({ isTTY: true } as NodeJS.ReadStream, { isTTY: false } as NodeJS.WriteStream), false);
  assert.equal(isInteractive({ isTTY: false } as NodeJS.ReadStream, { isTTY: false } as NodeJS.WriteStream), false);
});

test('fetchLatestRelease returns release data on success', async () => {
  const fetchImpl = async () =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: 'v0.0.2',
        assets: [{ name: 'afk-linux-x64', browser_download_url: 'https://example.com/afk-linux-x64' }],
      }),
    }) as unknown as Response;

  const result = await fetchLatestRelease({ owner: 'acme', repo: 'afk' }, fetchImpl);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.release.tag_name, 'v0.0.2');
  assert.equal(result.release.assets.length, 1);
  assert.equal(result.release.assets[0]?.name, 'afk-linux-x64');
});

test('fetchLatestRelease surfaces API errors as continue outcomes', async () => {
  const fetchImpl = async () =>
    ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
    }) as unknown as Response;

  const result = await fetchLatestRelease({ owner: 'acme', repo: 'afk' }, fetchImpl);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /404/);
});

test('fetchLatestRelease surfaces network failures as continue outcomes', async () => {
  const fetchImpl = async () => {
    throw new Error('network unreachable');
  };

  const result = await fetchLatestRelease({ owner: 'acme', repo: 'afk' }, fetchImpl);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /network unreachable/);
});

test('downloadAndReplace writes, chmods, renames, and re-executes the binary', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-'));
  const targetPath = path.join(dir, 'afk');
  writeFileSync(targetPath, 'old binary');

  const downloadCalls: string[] = [];
  const downloadImpl = async (url: string) => {
    downloadCalls.push(url);
    return new Uint8Array(Buffer.from('new binary'));
  };

  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const spawnImpl = (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return { unref: () => undefined };
  };

  const argv = ['/usr/local/bin/afk', 'status'];
  const result = await downloadAndReplace(
    { name: 'afk-linux-x64', browser_download_url: 'https://example.com/afk-linux-x64' },
    targetPath,
    argv,
    { download: downloadImpl, spawn: spawnImpl as SpawnLike },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(downloadCalls, ['https://example.com/afk-linux-x64']);
  assert.deepEqual(spawnCalls, [{ command: targetPath, args: ['status'] }]);

  const stat = statSync(targetPath);
  assert.equal(readFileSync(targetPath).toString(), 'new binary');
  assert.notEqual(stat.mode & 0o111, 0, 'target binary should be executable');
  assert.deepEqual(readdirSync(dir).sort(), ['afk']);
});

test('downloadAndReplace skips replacement when running from source', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-'));
  const scriptPath = path.join(dir, 'src', 'bin.ts');
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, 'source entry');

  let downloadCalled = false;
  let spawnCalled = false;

  const result = await downloadAndReplace(
    { name: 'afk-linux-x64', browser_download_url: 'https://example.com/afk-linux-x64' },
    scriptPath,
    ['bun', 'src/bin.ts'],
    {
      download: async () => {
        downloadCalled = true;
        return new Uint8Array();
      },
      spawn: () => {
        spawnCalled = true;
        return { unref: () => undefined };
      },
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /source/i);
  assert.equal(downloadCalled, false);
  assert.equal(spawnCalled, false);
  assert.equal(readFileSync(scriptPath).toString(), 'source entry');
});

test('downloadAndReplace surfaces download failures as continue outcomes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-'));
  const targetPath = path.join(dir, 'afk');
  writeFileSync(targetPath, 'old binary');

  const result = await downloadAndReplace(
    { name: 'afk-linux-x64', browser_download_url: 'https://example.com/afk-linux-x64' },
    targetPath,
    ['/usr/local/bin/afk'],
    {
      download: async () => {
        throw new Error('download timeout');
      },
      spawn: () => {
        return { unref: () => undefined };
      },
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /download timeout/);
  assert.equal(readFileSync(targetPath).toString(), 'old binary');
});

test('formatUpgradeNotice prints a one-line non-interactive message', () => {
  assert.equal(
    formatUpgradeNotice('0.0.1', '0.0.2'),
    'afk 0.0.1 → 0.0.2 available; run `afk` interactively to upgrade.',
  );
});
