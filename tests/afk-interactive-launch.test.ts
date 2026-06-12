import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  expandSelectedFeaturesToAllTickets,
  formatLinearDiscoveryLines,
  formatManualPermissionReviewLines,
  linearFeaturesToTicketRecords,
  linearMirrorPath,
  linearMirrorRoot,
  materializeLinearTicketMirrors,
  orderSelectedTicketsByFeatureGraph,
  readRunMetadata,
  readRunOutcomeLines,
  runAfk,
  validateSelectedFeatureDependencies,
  validateSelectedTicketDependencies,
} from '../src/cli.js';
import { formatModelSelectionTitle, prioritizeModelChoices } from '../src/interactive-launch.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { TicketRepository } from '../src/ticket-repository.js';

test('formats Linear parent feature work items without materializing launch tickets', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-launch-'));

  const lines = formatLinearDiscoveryLines([
    {
      provider: 'linear',
      id: 'parent-1',
      key: 'ENG-100',
      url: 'https://linear.app/acme/issue/ENG-100/parent',
      title: 'Parent feature',
      status: 'Ready',
      featureSlug: 'eng-100',
      workItems: [
        {
          provider: 'linear',
          id: 'child-1',
          key: 'ENG-101',
          url: 'https://linear.app/acme/issue/ENG-101/child',
          title: 'Child work',
          body: 'Implement child work.',
          status: 'Ready',
          parent: {
            id: 'parent-1',
            key: 'ENG-100',
            url: 'https://linear.app/acme/issue/ENG-100/parent',
            title: 'Parent feature',
            featureSlug: 'eng-100',
          },
          labels: [{ id: 'label-1', name: 'AFK' }],
          afkLabel: { id: 'label-1', name: 'AFK' },
          dependsOn: [],
        },
      ],
    },
  ]);

  assert.deepEqual(lines, [
    'Linear discovery found labeled subissues:',
    '- eng-100: ENG-100 - Parent feature (1 labeled subissues)',
    '  - ENG-101: Child work',
  ]);
  assert.equal(existsSync(path.join(repoRoot, '.scratch')), false);
});

test('converts Linear parent work items into selectable launch tickets', () => {
  const tickets = linearFeaturesToTicketRecords([
    {
      provider: 'linear',
      id: 'parent-1',
      key: 'ENG-100',
      url: 'https://linear.app/acme/issue/ENG-100/parent',
      title: 'Parent feature',
      status: 'Ready',
      featureSlug: 'eng-100',
      workItems: [
        {
          provider: 'linear',
          id: 'child-1',
          key: 'ENG-101',
          url: 'https://linear.app/acme/issue/ENG-101/child',
          title: 'Child work',
          body: 'Implement child work.',
          status: 'Ready',
          parent: {
            id: 'parent-1',
            key: 'ENG-100',
            url: 'https://linear.app/acme/issue/ENG-100/parent',
            title: 'Parent feature',
            featureSlug: 'eng-100',
          },
          labels: [{ id: 'label-1', name: 'AFK' }],
          afkLabel: { id: 'label-1', name: 'AFK' },
          dependsOn: [],
        },
      ],
    },
  ]);

  assert.deepEqual(
    tickets.map((ticket) => ({
      path: ticket.path,
      feature: ticket.feature,
      issueName: ticket.issueName,
      label: ticket.label,
      source: ticket.source,
      status: ticket.status,
      linear: ticket.linear,
    })),
    [
      {
        path: 'linear://ENG-101',
        feature: 'eng-100',
        issueName: 'eng-101',
        label: 'eng-100/eng-101',
        source: 'linear',
        status: 'ready-for-agent',
        linear: {
          parentKey: 'ENG-100',
          issueKey: 'ENG-101',
          parentBranchName: undefined,
          issueBranchName: undefined,
        },
      },
    ],
  );
  assert.match(tickets[0]?.content ?? '', /Linear issue: https:\/\/linear\.app\/acme\/issue\/ENG-101\/child/);
});

test('materializes Linear mirrors with safe paths and provider identity', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-mirror-'));
  const tickets = linearFeaturesToTicketRecords([
    linearFeature({
      featureSlug: '../ENG 100',
      parentKey: 'ENG-100',
      issueKey: '../../ENG-101',
      issueId: 'child-1',
      title: 'Child work',
      labels: [
        { id: 'label-1', name: 'AFK' },
        { id: 'label-2', name: 'Backend' },
      ],
    }),
  ]);

  const [ticket] = materializeLinearTicketMirrors(repoRoot, tickets);
  assert.ok(ticket);
  assert.equal(path.relative(linearMirrorRoot(repoRoot), ticket.path).startsWith('..'), false);
  assert.equal(ticket.providerIdentity?.mirrorPath, ticket.path);
  assert.equal(ticket.providerIdentity?.issueId, 'child-1');
  const mirror = readFileSync(ticket.path, 'utf8');
  assert.match(mirror, /Linear issue ID: child-1/);
  assert.match(mirror, /Linear issue key: ..\/..\/ENG-101/);
  assert.match(mirror, /Linear parent: ENG-100 - Parent feature/);
  assert.match(mirror, /Linear labels: AFK, Backend/);
  assert.match(mirror, /Dependency summary: None discovered by AFK Linear discovery\./);
});

test('Linear mirror path generation cannot escape the mirror root', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-safe-'));
  const mirrorPath = linearMirrorPath(repoRoot, '../../outside', '../ENG-101/../../escape');
  assert.equal(path.relative(linearMirrorRoot(repoRoot), mirrorPath).startsWith('..'), false);
  assert.equal(path.basename(mirrorPath), 'outside-eng-101-escape.md');
});

test('scratch ticket discovery ignores managed Linear mirrors', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-discovery-'));
  materializeLinearTicketMirrors(
    repoRoot,
    linearFeaturesToTicketRecords([
      linearFeature({ featureSlug: 'eng-100', parentKey: 'ENG-100', issueKey: 'ENG-101', issueId: 'child-1' }),
    ]),
  );

  assert.deepEqual(new TicketRepository(repoRoot).discoverTickets(), []);
});

test('default afk launch fails early without interactive tty', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never },
    env: { ...process.env, CI: '' },
  });
  assert.equal(result.code, 1);
  assert.match(result.message, /interactive terminal/i);
});

test('default afk launch fails early in ci mode', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  writeMinimalAfkConfig(repoRoot);
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: true } as never, stdout: { isTTY: true } as never },
    env: { ...process.env, CI: '1' },
  });
  assert.equal(result.code, 1);
  assert.match(result.message, /does not run in CI/i);
});

test('default afk launch requires afk.json before tty checks', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never },
    env: { ...process.env, CI: '' },
  });
  assert.equal(result.code, 1);
  assert.match(result.message, /Project config missing/);
  assert.match(result.message, /\/afk-config/);
});

test('returns friendly error for invalid ticket metadata', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-invalid-ticket-'));
  writeMinimalAfkConfig(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    'Status: ready-for-agent\n---\nstatus: ready-for-agent\nDepends-On:\n  - "00"\n---\n',
  );

  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: true } as never, stdout: { isTTY: true } as never },
    env: { ...process.env, CI: '' },
  });

  assert.equal(result.code, 1);
  assert.match(result.message, /Launch blocked by invalid ticket metadata/);
  assert.match(result.message, /legacy Status line before frontmatter is not supported/);
  assert.doesNotMatch(result.message, /at parseFrontmatter|\$bunfs|Bun v/);
});

test('model selection title includes provider and model label', () => {
  assert.equal(
    formatModelSelectionTitle({ id: 'github-copilot/gpt-5.4-mini', label: 'GPT-5.4 Mini' }),
    'github-copilot - GPT-5.4 Mini',
  );
});

test('model selection title falls back to model id segment', () => {
  assert.equal(formatModelSelectionTitle({ id: 'openai/gpt-5.5' }), 'openai - gpt-5.5');
});

test('prioritizes preferred model choice when available', () => {
  const choices = prioritizeModelChoices(
    [
      { id: 'provider/first', label: 'First' },
      { id: 'provider/last', label: 'Last' },
    ],
    'provider/last',
  );

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ['provider/last', 'provider/first'],
  );
});

test('ignores stale preferred model choice', () => {
  const choices = prioritizeModelChoices(
    [
      { id: 'provider/first', label: 'First' },
      { id: 'provider/last', label: 'Last' },
    ],
    'provider/missing',
  );

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ['provider/first', 'provider/last'],
  );
});

test('manual permission summary renders deterministic detailed rows', () => {
  const lines = formatManualPermissionReviewLines([
    {
      order: 1,
      recordedAt: '2026-01-01T00:00:00.000Z',
      request: {
        sessionId: 'session-1',
        permissionId: 'perm-1',
        type: 'bash',
        title: 'run tests',
        patterns: ['bun test'],
      },
      metadata: {
        ticketLabel: 'feat/01',
        sessionId: 'session-1',
        permissionId: 'perm-1',
        type: 'bash',
        title: 'run tests',
        patterns: ['bun test'],
        queuedCount: 0,
      },
      decision: 'once',
    },
    {
      order: 2,
      recordedAt: '2026-01-01T00:00:01.000Z',
      request: { sessionId: 'session-2', permissionId: 'perm-2', type: 'edit', title: 'edit file', patterns: [] },
      metadata: {
        ticketLabel: 'feat/02',
        sessionId: 'session-2',
        permissionId: 'perm-2',
        type: 'edit',
        title: 'edit file',
        patterns: [],
        queuedCount: 0,
      },
      decision: 'reject',
      safeDefaultReason: 'prompt-cancelled',
    },
  ]);

  assert.equal(lines[0], 'Manual permission review summary:');
  assert.match(lines[1] ?? '', /#1 \| ticket=feat\/01 \| session=session-1 \| permission=perm-1/);
  assert.match(lines[1] ?? '', /patterns=bun test \| decision=once \| recordedAt=2026-01-01T00:00:00.000Z/);
  assert.match(lines[2] ?? '', /#2 \| ticket=feat\/02 \| session=session-2 \| permission=perm-2/);
  assert.match(
    lines[2] ?? '',
    /patterns=none \| decision=reject \(prompt-cancelled\) \| recordedAt=2026-01-01T00:00:01.000Z/,
  );
});

test('manual permission summary reports no reviewed permissions when empty', () => {
  assert.deepEqual(formatManualPermissionReviewLines([]), ['Manual permission review: none required.']);
});

test('run outcome summary includes every selected ticket', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-outcomes-'));
  const store = new RuntimeStore({ repoRoot });
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(metadataRoot, { recursive: true });
  writeFileSync(
    path.join(metadataRoot, 'feat-a-01.json'),
    JSON.stringify({
      STATUS: 'failed',
      FAILURE_KIND: 'path-not-found',
      UNSAFE_REASON: 'missing file',
    }),
  );
  writeFileSync(
    path.join(metadataRoot, 'feat-b-02.json'),
    JSON.stringify({
      STATUS: 'completed',
      FINAL_REVIEW_OUTCOME: 'approved',
    }),
  );

  const lines = readRunOutcomeLines(store, repoRoot, [
    { feature: 'feat-a', issueName: '01', label: 'feat-a/01' },
    { feature: 'feat-b', issueName: '02', label: 'feat-b/02' },
  ]);

  assert.match(lines[0] ?? '', /1 failed before review/);
  assert.match(lines.join('\n'), /feat-a\/01: failed before review \(path-not-found\)/);
  assert.match(lines.join('\n'), /feat-b\/02: approved/);
});

test('run outcome ignores stale metadata from a previous launch', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-outcomes-stale-'));
  const store = new RuntimeStore({ repoRoot });
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(metadataRoot, { recursive: true });
  writeFileSync(
    path.join(metadataRoot, 'feat-01.json'),
    JSON.stringify({
      STATUS: 'completed',
      FINAL_REVIEW_OUTCOME: 'approved',
      START_EPOCH: 100,
    }),
  );

  const lines = readRunOutcomeLines(store, repoRoot, [{ feature: 'feat', issueName: '01', label: 'feat/01' }], {
    launchStartedAt: 200,
  });

  assert.equal(lines[0], 'Run outcome: mixed/unknown');
  assert.match(lines.join('\n'), /feat\/01: unknown \(stale runtime metadata from previous launch\)/);
});

test('run metadata displays Codex provider as Codex', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-status-codex-'));
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(metadataRoot, { recursive: true });
  writeFileSync(
    path.join(metadataRoot, 'feat-01.json'),
    JSON.stringify({ RUN_ID: 'run-codex', EXECUTION_PROVIDER: 'codex', EXECUTION_MODEL_ID: 'codex/default' }),
  );

  assert.deepEqual(readRunMetadata(repoRoot, 'run-codex'), {
    modelId: 'codex/default',
    harness: 'Codex',
    ticketCount: 1,
  });
});

test('run outcome ignores metadata from a different run id', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-outcomes-run-id-'));
  const store = new RuntimeStore({ repoRoot });
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(metadataRoot, { recursive: true });
  writeFileSync(
    path.join(metadataRoot, 'feat-01.json'),
    JSON.stringify({
      RUN_ID: 'previous-run',
      STATUS: 'completed',
      FINAL_REVIEW_OUTCOME: 'approved',
      START_EPOCH: 200,
    }),
  );

  const lines = readRunOutcomeLines(store, repoRoot, [{ feature: 'feat', issueName: '01', label: 'feat/01' }], {
    runId: 'current-run',
  });

  assert.equal(lines[0], 'Run outcome: mixed/unknown');
  assert.match(lines.join('\n'), /feat\/01: unknown \(runtime metadata from different run\)/);
});

test('run outcome reports scheduler not-scheduled results without reading stale metadata', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-outcomes-not-scheduled-'));
  const store = new RuntimeStore({ repoRoot });
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(metadataRoot, { recursive: true });
  writeFileSync(
    path.join(metadataRoot, 'feat-01.json'),
    JSON.stringify({
      RUN_ID: 'previous-run',
      STATUS: 'completed',
      FINAL_REVIEW_OUTCOME: 'approved',
    }),
  );

  const lines = readRunOutcomeLines(store, repoRoot, [{ feature: 'feat', issueName: '01', label: 'feat/01' }], {
    runId: 'current-run',
    ticketResults: [
      {
        ticket: { path: '/tmp/01.md', feature: 'feat', issueName: '01', label: 'feat/01', executorAfk: true },
        outcome: 'not-scheduled',
        message: 'Not scheduled because dependencies did not complete: feat/01',
        runId: 'current-run',
      },
    ],
  });

  assert.equal(lines[0], 'Run outcome: 1 blocked');
  assert.match(lines.join('\n'), /feat\/01: blocked \(not-scheduled\)/);
});

test('run outcome does not approve tickets left ready-for-agent', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-outcomes-ticket-state-'));
  const store = new RuntimeStore({ repoRoot });
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '01.md');
  mkdirSync(metadataRoot, { recursive: true });
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, '---\nfeature: feat\nstatus: ready-for-agent\n---\n\n## AFK Summary\n\nNot done\n');
  writeFileSync(
    path.join(metadataRoot, 'feat-01.json'),
    JSON.stringify({
      STATUS: 'completed',
      FINAL_REVIEW_OUTCOME: 'approved',
      START_EPOCH: 200,
    }),
  );

  const lines = readRunOutcomeLines(store, repoRoot, [
    { feature: 'feat', issueName: '01', label: 'feat/01', path: ticketPath },
  ]);

  assert.equal(lines[0], 'Run outcome: 1 blocked');
  assert.match(lines.join('\n'), /feat\/01: blocked \(ticket-status-not-done\)/);
});

test('launch dependency validation sees completed tickets filtered from eligible choices', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-deps-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: done\n---\n');
  writeFileSync(
    path.join(issuesDir, '02.md'),
    '---\nfeature: feat\nstatus: ready-for-agent\nDepends-On:\n  - "01"\n---\n',
  );

  const repository = new TicketRepository(repoRoot);
  const allTickets = repository.discoverTickets();
  const eligibleTickets = allTickets.filter((ticket) => repository.isEligible(ticket));

  assert.deepEqual(
    eligibleTickets.map((ticket) => ticket.issueName),
    ['02'],
  );
  assert.equal(validateSelectedTicketDependencies(eligibleTickets, allTickets), null);
});

test('selected features expand back to completed and eligible tickets', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-feature-expand-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: done\n---\n');
  writeFileSync(path.join(issuesDir, '02.md'), '---\nfeature: feat\nstatus: ready-for-agent\n---\n');

  const repository = new TicketRepository(repoRoot);
  const allTickets = repository.discoverTickets();
  const eligibleTickets = allTickets.filter((ticket) => repository.isEligible(ticket));
  const expanded = expandSelectedFeaturesToAllTickets(eligibleTickets, allTickets);

  assert.deepEqual(expanded.map((ticket) => ticket.issueName).sort(), ['01', '02']);
});

test('selected Linear feature tickets survive expansion without local scratch tickets', () => {
  const linearTicket = {
    path: 'linear://ENG-101',
    feature: 'eng-100',
    issueName: 'eng-101',
    label: 'eng-100/eng-101',
    status: 'ready-for-agent',
    executorAfk: true,
    source: 'linear' as const,
    content: '# Child work',
  };

  const expanded = expandSelectedFeaturesToAllTickets([linearTicket], [linearTicket]);

  assert.deepEqual(expanded, [linearTicket]);
});

test('selected feature tickets are ordered by dependency graph waves', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-feature-order-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01-foundation.md'), '---\nfeature: feat\nstatus: ready-for-agent\n---\n');
  writeFileSync(
    path.join(issuesDir, '02-middle.md'),
    '---\nfeature: feat\nstatus: ready-for-agent\nDepends-On:\n  - 01-foundation\n---\n',
  );
  writeFileSync(
    path.join(issuesDir, '03-verification.md'),
    '---\nfeature: feat\nstatus: ready-for-agent\nDepends-On:\n  - 02-middle\n---\n',
  );

  const repository = new TicketRepository(repoRoot);
  const allTickets = repository.discoverTickets();
  const graph = JSON.parse(
    JSON.stringify({
      feature: 'feat',
      version: 1,
      generatedAt: new Date().toISOString(),
      waves: [['01-foundation'], ['02-middle'], ['03-verification']],
      tickets: {},
    }),
  );
  const reversed = [...allTickets].sort((left, right) => right.issueName.localeCompare(left.issueName));

  assert.deepEqual(
    orderSelectedTicketsByFeatureGraph(reversed, { feat: graph }).map((ticket) => ticket.label),
    ['feat/01-foundation', 'feat/02-middle', 'feat/03-verification'],
  );
});

test('feature dependency validation blocks incomplete unselected upstream', () => {
  const graph = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    selectedFeatures: ['child'],
    concurrency: 3,
    featureWaves: [['parent'], ['child']],
    features: {
      parent: {
        state: 'ready' as const,
        dependsOnFeatures: [],
        blockedByFeatures: [],
        stackParent: null,
        blockingIssues: ['01'],
      },
      child: {
        state: 'blocked' as const,
        dependsOnFeatures: ['parent'],
        blockedByFeatures: ['parent'],
        stackParent: 'parent',
        blockingIssues: [],
        blockedReason: 'Blocked by incomplete unselected upstream feature(s): parent',
      },
    },
  };

  const block = validateSelectedFeatureDependencies(graph, ['child']);
  assert.ok(block);
  assert.match(block, /Launch blocked: child has incomplete upstream work/);
  assert.match(block, /parent/);
});

test('feature dependency validation passes for selected upstream', () => {
  const graph = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    selectedFeatures: ['parent', 'child'],
    concurrency: 3,
    featureWaves: [['parent'], ['child']],
    features: {
      parent: {
        state: 'ready' as const,
        dependsOnFeatures: [],
        blockedByFeatures: [],
        stackParent: null,
        blockingIssues: [],
      },
      child: {
        state: 'ready' as const,
        dependsOnFeatures: ['parent'],
        blockedByFeatures: [],
        stackParent: 'parent',
        blockingIssues: [],
      },
    },
  };

  assert.equal(validateSelectedFeatureDependencies(graph, ['parent', 'child']), null);
});

test('attaches to active run when healthy active-run.json exists', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-attach-'));
  writeMinimalAfkConfig(repoRoot);
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId: 'existing-run',
      pid: process.pid,
      startedAt: new Date(now - 10_000).toISOString(),
      heartbeatAt: new Date(now - 1_000).toISOString(),
      state: 'running',
      command: 'afk',
    })}\n`,
    'utf8',
  );

  const activeRunPath = path.join(logsDir, 'active-run.json');
  const clearActiveRun = setTimeout(() => rmSync(activeRunPath, { force: true }), 10);
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: true } as never, stdout: { isTTY: true } as never },
    env: { ...process.env, CI: '' },
  });
  clearTimeout(clearActiveRun);

  assert.equal(result.code, 0);
  assert.match(result.message, /Attached to active run/);
  assert.match(result.message, /existing-run/);
});

test('does not attach to stale active run with expired heartbeat', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-stale-'));
  writeMinimalAfkConfig(repoRoot);
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId: 'stale-run',
      pid: process.pid,
      startedAt: new Date(100_000).toISOString(),
      heartbeatAt: new Date(100_001).toISOString(),
      state: 'running',
      command: 'afk',
    })}\n`,
    'utf8',
  );

  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: true } as never, stdout: { isTTY: true, write: () => {} } as never },
    env: { ...process.env, CI: '' },
  });

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.message, /Attached to active run/);
  assert.match(result.message, /No pending AFK tickets found/);
});

function linearFeature(input: {
  featureSlug: string;
  parentKey: string;
  issueKey: string;
  issueId: string;
  title?: string;
  labels?: { id: string; name: string }[];
}) {
  const labels = input.labels ?? [{ id: 'label-1', name: 'AFK' }];
  return {
    provider: 'linear' as const,
    id: 'parent-1',
    key: input.parentKey,
    url: `https://linear.app/acme/issue/${input.parentKey}/parent`,
    title: 'Parent feature',
    status: 'Ready',
    featureSlug: input.featureSlug,
    workItems: [
      {
        provider: 'linear' as const,
        id: input.issueId,
        key: input.issueKey,
        url: `https://linear.app/acme/issue/${input.issueKey}/child`,
        title: input.title ?? 'Child work',
        body: 'Implement child work.',
        status: 'Ready',
        parent: {
          id: 'parent-1',
          key: input.parentKey,
          url: `https://linear.app/acme/issue/${input.parentKey}/parent`,
          title: 'Parent feature',
          featureSlug: input.featureSlug,
        },
        labels,
        afkLabel: labels[0],
      },
    ],
  };
}

function writeMinimalAfkConfig(repoRoot: string): void {
  writeFileSync(path.join(repoRoot, 'afk.json'), JSON.stringify({ testsEnabled: false, staticCheckCommands: [] }));
}
