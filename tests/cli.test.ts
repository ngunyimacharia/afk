import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { displayNameForProvider, readRunMetadata, runAfk } from '../src/cli.js';
import { parseCliArgs } from '../src/cli-flags.js';
import { formatJsonError, formatJsonSuccess, formatJsonSuccessWithData } from '../src/cli-response.js';
import { assetNameForPlatform } from '../src/upgrade.js';

class FakeLinearProvider {
  readonly issues: Array<{ title: string; parentId?: string }> = [];
  labelId = 'label-afk';
  stateId = 'state-ready';

  async resolveIssueLabelId(): Promise<string | undefined> {
    return this.labelId;
  }

  async resolveWorkflowStateId(): Promise<string | undefined> {
    return this.stateId;
  }

  async createIssue(input: { title: string; parentId?: string }): Promise<{ id: string; key: string; url: string }> {
    this.issues.push(input);
    const key = `AFK-${this.issues.length}`;
    return { id: `issue-${this.issues.length}`, key, url: `https://linear.app/acme/issue/${key}` };
  }

  async createIssueDependency(): Promise<void> {
    // no-op
  }
}

function writeMinimalAfkConfig(repoRoot: string): void {
  writeFileSync(path.join(repoRoot, 'afk.json'), JSON.stringify({ testsEnabled: false, staticCheckCommands: [] }));
}

const allHarnessModels = {
  PI: [{ id: 'pi/default', label: 'PI default' }],
};

function runArgs(sandbox = 'docker') {
  return [
    'bun',
    'src/bin.ts',
    'run',
    '--model',
    'pi/default',
    '--reviewer-model',
    'pi/default',
    '--features',
    'feat',
    '--concurrency',
    '1',
    '--completion',
    'create-pr',
    '--sandbox',
    sandbox,
    '--json',
  ];
}

function dockerRunRuntime(overrides: object = {}) {
  return {
    discoverAvailableHarnesses: async () =>
      ({ availableHarnesses: Object.keys(allHarnessModels), harnessModelCache: allHarnessModels }) as never,
    detectDockerAvailable: () => true,
    validateSandcastleRuntimeImage: async () =>
      ({ ok: true, image: 'afk-runtime:latest', capability: 'afk.phase-executor.v1' }) as never,
    dockerAuthPathExists: () => true,
    env: {
      OPENCODE_AUTH: 'token',
      ANTHROPIC_API_KEY: 'token',
      OPENAI_API_KEY: 'token',
      PI_API_KEY: 'token',
    },
    skipUpgradeCheck: true,
    ...overrides,
  };
}

test('displayNameForProvider maps current provider names', () => {
  assert.equal(displayNameForProvider('pi'), 'PI');
  assert.equal(displayNameForProvider('unknown'), 'unknown');
});

test('readRunMetadata maps current provider names to display names', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-cli-metadata-'));
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(metadataRoot, { recursive: true });

  const runId = 'run-123';
  writeFileSync(
    path.join(metadataRoot, 'feat-001.json'),
    JSON.stringify({
      RUN_ID: runId,
      EXECUTION_MODEL_ID: 'pi/default',
      EXECUTION_PROVIDER: 'pi',
    }),
    'utf8',
  );

  const metadata = readRunMetadata(repoRoot, runId);
  assert.equal(metadata.modelId, 'pi/default');
  assert.equal(metadata.harness, 'PI');
  assert.equal(metadata.ticketCount, 1);
});

test('parseCliArgs detects --json and string flags from script invocation', () => {
  const parsed = parseCliArgs(['bun', 'src/bin.ts', 'run', '--json', '--model=pi/default']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.model, 'pi/default');
});

test('parseCliArgs detects command from compiled binary invocation', () => {
  const parsed = parseCliArgs(['afk', 'status', '--json']);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.flags.json, true);
});

test('parseCliArgs supports comma-separated list, integer, and byte offset flags', () => {
  const parsed = parseCliArgs([
    'bun',
    'src/bin.ts',
    'run',
    '--features',
    'feat-a,feat-b',
    '--concurrency=3',
    '--offset',
    '1024',
  ]);
  assert.deepEqual(parsed.flags.features, ['feat-a', 'feat-b']);
  assert.equal(parsed.flags.concurrency, 3);
  assert.equal(parsed.flags.offset, 1024);
});

test('parseCliArgs ignores unknown flags without consuming positionals', () => {
  const parsed = parseCliArgs(['bun', 'src/bin.ts', 'linear-plan', '--manifest', 'plan.json']);
  assert.equal(parsed.command, 'linear-plan');
  assert.equal(parsed.flags.manifest, 'plan.json');
  assert.deepEqual(parsed.positionals, []);
});

test('parseCliArgs does not interfere with existing boolean flags', () => {
  const parsed = parseCliArgs(['bun', 'src/bin.ts', 'cleanup', '--dry-run', '--verbose', '-v']);
  assert.equal(parsed.command, 'afk-cleanup');
  assert.equal(parsed.flags.dryRun, true);
  assert.equal(parsed.flags.verbose, true);
});

test('parseCliArgs recognizes --version and -V flags', () => {
  assert.equal(parseCliArgs(['afk', '--version']).flags.version, true);
  assert.equal(parseCliArgs(['afk', '-V']).flags.version, true);
  assert.equal(parseCliArgs(['bun', 'src/bin.ts', '--version']).flags.version, true);
});

test('parseCliArgs recognizes version command', () => {
  assert.equal(parseCliArgs(['afk', 'version']).command, 'version');
});

test('formatJsonSuccess omits empty message field', () => {
  const result = formatJsonSuccess('status', '');
  const parsed = JSON.parse(result.message) as { ok: boolean; command: string; message?: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'status');
  assert.equal('message' in parsed, false);
});

test('formatJsonSuccess includes non-empty message field', () => {
  const result = formatJsonSuccess('stop', 'Stopped');
  const parsed = JSON.parse(result.message) as { ok: boolean; message?: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.message, 'Stopped');
});

test('formatJsonSuccessWithData places object in data field', () => {
  const result = formatJsonSuccessWithData('linear-plan', { plan: true });
  const parsed = JSON.parse(result.message) as { ok: boolean; data: object };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { plan: true });
});

test('formatJsonError includes code, message, and optional details', () => {
  const result = formatJsonError('run', 'missing-required-flag', 'Missing flag', { flag: '--features' });
  const parsed = JSON.parse(result.message) as {
    ok: boolean;
    error: { code: string; message: string; details?: object };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'missing-required-flag');
  assert.equal(parsed.error.message, 'Missing flag');
  assert.deepEqual(parsed.error.details, { flag: '--features' });
});

test('run returns JSON missing-required-flag error without required flags', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-run-json-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'run', '--json'], skipUpgradeCheck: true });
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.message) as { ok: false; command: string; error: { code: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.error.code, 'missing-required-flag');
});

test('run returns human-readable missing-required-flag error without required flags', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-run-text-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'run'], skipUpgradeCheck: true });
  assert.equal(result.code, 1);
  assert.match(result.message, /Missing required flag: --model/);
});

test('docker sandbox run fails before launch when Docker is unavailable', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-docker-missing-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, dockerRunRuntime({ argv: runArgs(), detectDockerAvailable: () => false }));
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.message).error.code, 'docker-unavailable');
});

test('docker sandbox run fails before launch when runtime image is unavailable', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-docker-image-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(
    repoRoot,
    dockerRunRuntime({
      argv: runArgs(),
      validateSandcastleRuntimeImage: async () => ({
        ok: false,
        failure: { kind: 'missing-image', image: 'afk-runtime:latest', message: 'runtime image missing' },
      }),
    }),
  );
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.message).error.code, 'docker-runtime-image-unavailable');
});

test('docker sandbox run validates missing implementation auth for PI', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-docker-auth-PI-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(
    repoRoot,
    dockerRunRuntime({ argv: runArgs(), env: {}, dockerAuthPathExists: () => false }),
  );
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.error.code, 'docker-auth-unavailable');
  assert.match(parsed.error.message, /implementation:/);
});

test('docker sandbox run validates missing reviewer auth for PI', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-docker-reviewer-auth-PI-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(
    repoRoot,
    dockerRunRuntime({ argv: runArgs(), env: {}, dockerAuthPathExists: () => false }),
  );
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.error.code, 'docker-auth-unavailable');
  assert.match(parsed.error.message, /reviewer: Sandcastle pi Docker auth is unavailable/);
});

test('no-sandbox run bypasses Docker-specific validation for PI', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-no-sandbox-bypass-PI-'));
  writeMinimalAfkConfig(repoRoot);
  let dockerChecked = false;
  const result = await runAfk(
    repoRoot,
    dockerRunRuntime({
      argv: runArgs('no-sandbox'),
      detectDockerAvailable: () => {
        dockerChecked = true;
        return false;
      },
      env: {},
      dockerAuthPathExists: () => false,
    }),
  );
  assert.equal(dockerChecked, false);
  assert.equal(result.code, 1);
  assert.notEqual(JSON.parse(result.message).error.code, 'docker-auth-unavailable');
});

for (const command of ['pause', 'resume']) {
  test(`${command} returns JSON no-active-run error when --json is passed without an active run`, async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), `afk-${command}-json-`));
    writeMinimalAfkConfig(repoRoot);
    const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', command, '--json'], skipUpgradeCheck: true });
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.message) as { ok: false; command: string; error: { code: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, command);
    assert.equal(parsed.error.code, 'no-active-run');
  });
}

for (const command of ['plan', 'events']) {
  test(`${command} returns stable JSON error when --json is passed`, async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), `afk-${command}-json-`));
    writeMinimalAfkConfig(repoRoot);
    const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', command, '--json'], skipUpgradeCheck: true });
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.message) as { ok: false; command: string; error: { code: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, command);
    assert.equal(parsed.error.code, 'not-implemented');
  });
}

test('unknown command returns JSON error with --json', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-unknown-json-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'nope', '--json'], skipUpgradeCheck: true });
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.message) as { ok: false; command: string; error: { code: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'nope');
  assert.equal(parsed.error.code, 'unknown-command');
});

test('unknown command returns human-readable error without --json', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-unknown-text-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'nope'], skipUpgradeCheck: true });
  assert.equal(result.code, 1);
  assert.match(result.message, /Unknown command/);
});

test('bare afk with --json returns JSON error for missing interactive terminal', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-bare-json-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, {
    argv: ['bun', 'src/bin.ts', '--json'],
    io: { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never },
    env: { ...process.env, CI: '' },
    skipUpgradeCheck: true,
  });
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.message) as { ok: false; error: { code: string; message: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'command-failed');
  assert.match(parsed.error.message, /interactive terminal/i);
});

test('status JSON output reports inactive run as structured data', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-status-json-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'status', '--json'], skipUpgradeCheck: true });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.message) as {
    ok: true;
    command: string;
    data: { active: boolean; pendingPostMergeCleanupDebt: number };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.data.active, false);
  assert.equal(typeof parsed.data.pendingPostMergeCleanupDebt, 'number');
});

test('linear-plan JSON output uses data field for plan payload', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-plan-json-'));
  const manifestPath = path.join(repoRoot, 'manifest.json');
  writeMinimalAfkConfig(repoRoot);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      parents: [
        {
          ref: 'parent',
          title: 'Parent issue',
          description: 'Parent description',
          subIssues: [{ ref: 'api', title: 'Build API', description: 'API description' }],
        },
      ],
    }),
  );
  writeFileSync(
    path.join(repoRoot, 'afk.json'),
    JSON.stringify({
      testsEnabled: false,
      staticCheckCommands: [],
      linear: {
        teamId: 'team-1',
        labelName: 'AFK',
        afkLabelName: 'AFK',
        readyStateName: 'Ready',
        apiKey: 'test-key',
        projectId: 'project-1',
        workflowStates: { ready: 'Ready', running: 'Running', done: 'Done', handoff: 'Handoff' },
      },
    }),
  );
  const result = await runAfk(repoRoot, {
    argv: ['bun', 'src/bin.ts', 'linear-plan', manifestPath, '--json'],
    linearProvider: new FakeLinearProvider() as never,
    skipUpgradeCheck: true,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.message) as { ok: true; command: string; data: object; message?: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'linear-plan');
  assert.ok(parsed.data);
  assert.equal('message' in parsed, false);
});

test('version command prints version as text', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-version-text-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['afk', 'version'], skipUpgradeCheck: true });
  assert.equal(result.code, 0);
  assert.match(result.message, /^\d+\.\d+\.\d+/);
});

test('--version prints version as JSON when --json is passed', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-version-json-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['afk', '--version', '--json'], skipUpgradeCheck: true });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.message) as { ok: true; command: string; data: { version: string } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'version');
  assert.match(parsed.data.version, /^\d+\.\d+\.\d+/);
});

test('upgrade check prints a notice and continues in CI mode', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-ci-'));
  writeMinimalAfkConfig(repoRoot);
  const output: string[] = [];
  const result = await runAfk(repoRoot, {
    argv: ['afk', 'status'],
    env: { ...process.env, CI: 'true' },
    io: {
      stdin: { isTTY: false } as never,
      stdout: { isTTY: false, write: (chunk: string) => output.push(chunk) } as never,
    },
    upgradeDependencies: {
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
  });
  assert.equal(result.code, 0);
  assert.ok(output.some((line) => /available/.test(line)));
  assert.match(result.message, /No active AFK run/);
});

test('upgrade check prints a notice and continues with --json', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-json-'));
  writeMinimalAfkConfig(repoRoot);
  const output: string[] = [];
  const result = await runAfk(repoRoot, {
    argv: ['afk', 'status', '--json'],
    env: { ...process.env, CI: '' },
    io: {
      stdin: { isTTY: false } as never,
      stdout: { isTTY: false, write: (chunk: string) => output.push(chunk) } as never,
    },
    upgradeDependencies: {
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
  });
  assert.equal(result.code, 0);
  assert.ok(output.some((line) => /available/.test(line)));
  const parsed = JSON.parse(result.message) as { ok: true; command: string; data: { active: boolean } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.data.active, false);
});

test('upgrade check continues original command when user declines', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-decline-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, {
    argv: ['afk', 'status'],
    env: { ...process.env, CI: '' },
    io: { stdin: { isTTY: true } as never, stdout: { isTTY: true } as never },
    upgradeDependencies: {
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
  });
  assert.equal(result.code, 0);
  assert.match(result.message, /No active AFK run/);
});

test('upgrade check downloads, replaces, and re-executes when user accepts', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-upgrade-accept-'));
  writeMinimalAfkConfig(repoRoot);
  const events: string[] = [];
  const result = await runAfk(repoRoot, {
    argv: ['afk', 'status'],
    env: { ...process.env, CI: '' },
    io: { stdin: { isTTY: true } as never, stdout: { isTTY: true } as never },
    upgradeDependencies: {
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
  });
  assert.equal(result.code, 0);
  assert.equal(events.length, 3);
  assert.match(events[0], /^download:/);
  assert.match(events[1], /^replace:/);
  assert.match(events[2], /^reexec:/);
});
