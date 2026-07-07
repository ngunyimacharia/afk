import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { displayNameForProvider, readRunMetadata, runAfk } from '../src/cli.js';
import { parseCliArgs } from '../src/cli-flags.js';
import { formatJsonError, formatJsonSuccess, formatJsonSuccessWithData } from '../src/cli-response.js';

const packageVersion = (JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version;

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

test('displayNameForProvider maps current provider names', () => {
  assert.equal(displayNameForProvider('opencode'), 'OpenCode');
  assert.equal(displayNameForProvider('claude'), 'Claude');
  assert.equal(displayNameForProvider('codex'), 'Codex');
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
      EXECUTION_MODEL_ID: 'kimi/kimi-for-coding',
      EXECUTION_PROVIDER: 'claude',
    }),
    'utf8',
  );

  const metadata = readRunMetadata(repoRoot, runId);
  assert.equal(metadata.modelId, 'kimi/kimi-for-coding');
  assert.equal(metadata.harness, 'Claude');
  assert.equal(metadata.ticketCount, 1);
});

test('parseCliArgs detects --json and string flags from script invocation', () => {
  const parsed = parseCliArgs(['bun', 'src/bin.ts', 'run', '--json', '--harness', 'Codex', '--model=codex/default']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.harness, 'Codex');
  assert.equal(parsed.flags.model, 'codex/default');
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

test('parseCliArgs recognizes --version / -V flags and the version command', () => {
  const flagParsed = parseCliArgs(['bun', 'src/bin.ts', '--version']);
  assert.equal(flagParsed.command, undefined);
  assert.equal(flagParsed.flags.version, true);

  const shorthandParsed = parseCliArgs(['bun', 'src/bin.ts', '-V']);
  assert.equal(shorthandParsed.flags.version, true);

  const commandParsed = parseCliArgs(['bun', 'src/bin.ts', 'version']);
  assert.equal(commandParsed.command, 'version');
  assert.equal(commandParsed.flags.version, false);
});

test('parseCliArgs recognizes version command from compiled binary invocation', () => {
  const parsed = parseCliArgs(['afk', 'version']);
  assert.equal(parsed.command, 'version');
});

test('version command prints package version', async () => {
  const result = await runAfk(process.cwd(), { argv: ['bun', 'src/bin.ts', 'version'] });
  assert.equal(result.code, 0);
  assert.equal(result.message, packageVersion);
});

test('--version flag prints package version', async () => {
  const result = await runAfk(process.cwd(), { argv: ['bun', 'src/bin.ts', '--version'] });
  assert.equal(result.code, 0);
  assert.equal(result.message, packageVersion);
});

test('-V flag prints package version', async () => {
  const result = await runAfk(process.cwd(), { argv: ['bun', 'src/bin.ts', '-V'] });
  assert.equal(result.code, 0);
  assert.equal(result.message, packageVersion);
});

test('version command prints JSON envelope with --json', async () => {
  const result = await runAfk(process.cwd(), { argv: ['bun', 'src/bin.ts', 'version', '--json'] });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.message) as { ok: true; command: string; data: { version: string } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'version');
  assert.equal(parsed.data.version, packageVersion);
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
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'run', '--json'] });
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.message) as { ok: false; command: string; error: { code: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.error.code, 'missing-required-flag');
});

test('run returns human-readable missing-required-flag error without required flags', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-run-text-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'run'] });
  assert.equal(result.code, 1);
  assert.match(result.message, /Missing required flag: --harness/);
});

for (const command of ['pause', 'resume']) {
  test(`${command} returns JSON no-active-run error when --json is passed without an active run`, async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), `afk-${command}-json-`));
    writeMinimalAfkConfig(repoRoot);
    const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', command, '--json'] });
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
    const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', command, '--json'] });
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
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'nope', '--json'] });
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.message) as { ok: false; command: string; error: { code: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'nope');
  assert.equal(parsed.error.code, 'unknown-command');
});

test('unknown command returns human-readable error without --json', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-unknown-text-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'nope'] });
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
  const result = await runAfk(repoRoot, { argv: ['bun', 'src/bin.ts', 'status', '--json'] });
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
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.message) as { ok: true; command: string; data: object; message?: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'linear-plan');
  assert.ok(parsed.data);
  assert.equal('message' in parsed, false);
});
