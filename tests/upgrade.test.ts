import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assetNameForPlatform,
  checkForUpgrade,
  defaultDownloadAsset,
  defaultReplaceBinary,
  fetchLatestGitHubRelease,
  isSourceMode,
  isUpgradeAvailable,
  parseSemver,
  resolveTargetPath,
  selectAsset,
} from '../src/upgrade.js';

test('parseSemver parses core versions and prereleases', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseSemver('v0.1.2-alpha.1'), { major: 0, minor: 1, patch: 2, prerelease: ['alpha', '1'] });
});

test('isUpgradeAvailable compares versions by semver', () => {
  assert.equal(isUpgradeAvailable('0.0.1', '0.0.2'), true);
  assert.equal(isUpgradeAvailable('0.0.2', '0.0.1'), false);
  assert.equal(isUpgradeAvailable('0.0.2', '0.0.2'), false);
  assert.equal(isUpgradeAvailable('0.1.0', '0.2.0'), true);
  assert.equal(isUpgradeAvailable('1.0.0', '2.0.0'), true);
  assert.equal(isUpgradeAvailable('0.0.2', '0.0.2-alpha'), false);
});

test('assetNameForPlatform builds platform-specific names', () => {
  assert.equal(assetNameForPlatform('linux', 'x64'), 'afk-linux-x64');
  assert.equal(assetNameForPlatform('darwin', 'arm64'), 'afk-macos-arm64');
  assert.equal(assetNameForPlatform('win32', 'x64'), 'afk-windows-x64');
});

test('selectAsset returns the matching asset or null', () => {
  const assets = [
    { name: 'afk-linux-x64', browserDownloadUrl: 'https://example.com/linux' },
    { name: 'afk-macos-arm64', browserDownloadUrl: 'https://example.com/macos' },
  ];
  assert.equal(selectAsset('linux', 'x64', assets)?.name, 'afk-linux-x64');
  assert.equal(selectAsset('darwin', 'x64', assets), null);
});

test('isSourceMode detects TypeScript and JavaScript entry points', () => {
  assert.equal(isSourceMode('src/bin.ts'), true);
  assert.equal(isSourceMode('src/bin.js'), true);
  assert.equal(isSourceMode('/usr/local/bin/afk'), false);
});

test('resolveTargetPath prefers binary path over script path', () => {
  assert.equal(resolveTargetPath(['/usr/local/bin/afk', 'status']), '/usr/local/bin/afk');
  assert.equal(resolveTargetPath(['bun', 'src/bin.ts', 'status']), path.resolve('src/bin.ts'));
});

test('checkForUpgrade continues when no release is available', async () => {
  const result = await checkForUpgrade(
    {
      currentVersion: '0.0.1',
      argv: ['afk', 'status'],
      targetPath: '/usr/local/bin/afk',
      isInteractive: true,
      isJson: false,
      isSourceMode: false,
    },
    {
      fetchLatestRelease: async () => null,
      prompt: async () => true,
      downloadAsset: async () => {},
      replaceBinary: async () => {},
      reexec: async () => {
        throw new Error('should not reexec');
      },
    },
  );
  assert.equal(result.action, 'continue');
});

test('checkForUpgrade continues when already on latest version', async () => {
  const result = await checkForUpgrade(
    {
      currentVersion: '0.0.2',
      argv: ['afk', 'status'],
      targetPath: '/usr/local/bin/afk',
      isInteractive: true,
      isJson: false,
      isSourceMode: false,
    },
    {
      fetchLatestRelease: async () => ({
        tagName: 'v0.0.2',
        version: '0.0.2',
        assets: [{ name: 'afk-linux-x64', browserDownloadUrl: 'https://example.com/afk' }],
      }),
      prompt: async () => true,
      downloadAsset: async () => {},
      replaceBinary: async () => {},
      reexec: async () => {
        throw new Error('should not reexec');
      },
    },
  );
  assert.equal(result.action, 'continue');
});

test('checkForUpgrade skips in non-interactive mode with a notice', async () => {
  const result = await checkForUpgrade(
    {
      currentVersion: '0.0.1',
      argv: ['afk', 'status'],
      targetPath: '/usr/local/bin/afk',
      isInteractive: false,
      isJson: false,
      isSourceMode: false,
    },
    {
      fetchLatestRelease: async () => ({
        tagName: 'v0.0.2',
        version: '0.0.2',
        assets: [
          { name: assetNameForPlatform(process.platform, process.arch), browserDownloadUrl: 'https://example.com/afk' },
        ],
      }),
      prompt: async () => true,
      downloadAsset: async () => {},
      replaceBinary: async () => {},
      reexec: async () => {
        throw new Error('should not reexec');
      },
    },
  );
  assert.equal(result.action, 'skipped');
  assert.match(result.message ?? '', /available/);
});

test('checkForUpgrade continues when user declines', async () => {
  const result = await checkForUpgrade(
    {
      currentVersion: '0.0.1',
      argv: ['afk', 'status'],
      targetPath: '/usr/local/bin/afk',
      isInteractive: true,
      isJson: false,
      isSourceMode: false,
    },
    {
      fetchLatestRelease: async () => ({
        tagName: 'v0.0.2',
        version: '0.0.2',
        assets: [
          { name: assetNameForPlatform(process.platform, process.arch), browserDownloadUrl: 'https://example.com/afk' },
        ],
      }),
      prompt: async () => false,
      downloadAsset: async () => {},
      replaceBinary: async () => {},
      reexec: async () => {
        throw new Error('should not reexec');
      },
    },
  );
  assert.equal(result.action, 'continue');
});

test('checkForUpgrade downloads, replaces, and re-executes when user confirms', async () => {
  const events: string[] = [];
  const result = await checkForUpgrade(
    {
      currentVersion: '0.0.1',
      argv: ['afk', 'status'],
      targetPath: '/usr/local/bin/afk',
      isInteractive: true,
      isJson: false,
      isSourceMode: false,
    },
    {
      fetchLatestRelease: async () => ({
        tagName: 'v0.0.2',
        version: '0.0.2',
        assets: [
          { name: assetNameForPlatform(process.platform, process.arch), browserDownloadUrl: 'https://example.com/afk' },
        ],
      }),
      prompt: async () => true,
      downloadAsset: async (url, tempPath) => {
        events.push(`download:${url}:${tempPath}`);
      },
      replaceBinary: async (tempPath, targetPath) => {
        events.push(`replace:${tempPath}:${targetPath}`);
      },
      reexec: async (targetPath, argv) => {
        events.push(`reexec:${targetPath}:${argv.join(',')}`);
        return undefined as never;
      },
    },
  );
  assert.equal(result.action, 'restarted');
  assert.equal(events.length, 3);
  assert.match(events[0], /^download:/);
  assert.match(events[1], /^replace:/);
  assert.match(events[2], /^reexec:/);
});

test('checkForUpgrade continues on download failure', async () => {
  const result = await checkForUpgrade(
    {
      currentVersion: '0.0.1',
      argv: ['afk', 'status'],
      targetPath: '/usr/local/bin/afk',
      isInteractive: true,
      isJson: false,
      isSourceMode: false,
    },
    {
      fetchLatestRelease: async () => ({
        tagName: 'v0.0.2',
        version: '0.0.2',
        assets: [
          { name: assetNameForPlatform(process.platform, process.arch), browserDownloadUrl: 'https://example.com/afk' },
        ],
      }),
      prompt: async () => true,
      downloadAsset: async () => {
        throw new Error('network error');
      },
      replaceBinary: async () => {},
      reexec: async () => {
        throw new Error('should not reexec');
      },
    },
  );
  assert.equal(result.action, 'continue');
  assert.match(result.message ?? '', /network error/);
});

test('defaultReplaceBinary writes executable file and renames atomically', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-replace-'));
  const tempPath = path.join(tempDir, 'afk.new');
  const targetPath = path.join(tempDir, 'afk');
  writeFileSync(tempPath, 'binary', 'utf8');
  await defaultReplaceBinary(tempPath, targetPath);
  assert.equal(readFileSync(targetPath, 'utf8'), 'binary');
});

test('fetchLatestGitHubRelease parses latest release payload', async () => {
  const release = await fetchLatestGitHubRelease('owner', 'repo', async (url) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/releases/latest');
    return new Response(
      JSON.stringify({
        tag_name: 'v0.0.2',
        assets: [{ name: 'afk-linux-x64', browser_download_url: 'https://example.com/afk' }],
      }),
    );
  });
  assert.equal(release?.version, '0.0.2');
  assert.equal(release?.assets[0]?.name, 'afk-linux-x64');
});

test('fetchLatestGitHubRelease returns null on error response', async () => {
  const release = await fetchLatestGitHubRelease(
    'owner',
    'repo',
    async () => new Response('Not found', { status: 404 }),
  );
  assert.equal(release, null);
});

test('defaultDownloadAsset writes response body to file', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-download-'));
  const tempPath = path.join(tempDir, 'afk.asset');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('downloaded-binary', {
      status: 200,
    }) as never;
  try {
    await defaultDownloadAsset('https://example.com/afk', tempPath);
    assert.equal(readFileSync(tempPath, 'utf8'), 'downloaded-binary');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
