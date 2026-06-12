import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeTrackerWorkItemKey,
  scratchTrackerWorkItemKey,
  type TrackerProvider,
  type TrackerWorkItem,
  ticketRecordToTrackerWorkItem,
  trackerWorkItemToTicketRecord,
} from '../src/tracker-contract.js';

test('normalizes provider work item keys without filesystem paths', () => {
  assert.equal(normalizeTrackerWorkItemKey({ provider: 'linear-graphql', id: ' AFK-123 ' }), 'linear-graphql:afk-123');
  assert.equal(normalizeTrackerWorkItemKey(scratchTrackerWorkItemKey('feat', '01-ticket')), 'scratch:feat/01-ticket');
  assert.throws(() => normalizeTrackerWorkItemKey({ provider: 'scratch', id: '   ' }), /key id is required/);
});

test('converts provider work items to scheduler ticket records', () => {
  const item: TrackerWorkItem = {
    key: { provider: 'linear-graphql', id: 'LIN-42' },
    feature: 'tracker-provider-contract',
    issueName: '01-define-contract',
    label: 'tracker-provider-contract/01-define-contract',
    status: 'ready-for-agent',
    executorAfk: false,
    dependsOn: ['00-prereq', 'other-feature/02-external'],
    title: 'Define tracker contract',
    body: 'Provider-neutral tracker issue body.',
    providerRef: {
      key: { provider: 'linear-graphql', id: 'LIN-42' },
      displayId: 'LIN-42',
      url: 'https://linear.app/team/issue/LIN-42',
    },
    url: 'https://linear.app/team/issue/LIN-42',
  };

  assert.deepEqual(trackerWorkItemToTicketRecord(item), {
    path: '',
    feature: 'tracker-provider-contract',
    issueName: '01-define-contract',
    label: 'tracker-provider-contract/01-define-contract',
    status: 'ready-for-agent',
    executorAfk: false,
    dependsOn: ['tracker-provider-contract/00-prereq', 'other-feature/02-external'],
    provider: {
      kind: 'linear-graphql',
      id: 'LIN-42',
      displayId: 'LIN-42',
      url: 'https://linear.app/team/issue/LIN-42',
    },
  });
});

test('converts scheduler ticket records to scratch provider work items', () => {
  const item = ticketRecordToTrackerWorkItem(
    {
      path: '/repo/.scratch/feat/issues/01.md',
      feature: 'feat',
      issueName: '01',
      label: 'feat/01',
      status: 'ready-for-agent',
      executorAfk: true,
      dependsOn: ['feat/00'],
    },
    '# Ticket body',
  );

  assert.deepEqual(item, {
    key: { provider: 'scratch', id: 'feat/01' },
    feature: 'feat',
    issueName: '01',
    label: 'feat/01',
    status: 'ready-for-agent',
    executorAfk: true,
    dependsOn: ['feat/00'],
    title: 'feat/01',
    body: '# Ticket body',
    providerRef: { key: { provider: 'scratch', id: 'feat/01' }, displayId: '01' },
    materializedFiles: { ticketPath: '/repo/.scratch/feat/issues/01.md' },
  });
});

test('round-trips scratch ticket paths through provider work items', () => {
  const ticketPath = '/repo/.scratch/feat/issues/01.md';
  const item = ticketRecordToTrackerWorkItem(
    {
      path: ticketPath,
      feature: 'feat',
      issueName: '01',
      label: 'feat/01',
      status: 'ready-for-agent',
      executorAfk: true,
      dependsOn: [],
    },
    '# Ticket body',
  );

  assert.equal(trackerWorkItemToTicketRecord(item).path, ticketPath);
});

test('tracker provider contract exposes operations needed by external issue providers', () => {
  const provider = {
    kind: 'linear-graphql',
    capabilities: {
      list: true,
      get: true,
      create: true,
      update: true,
      appendComment: true,
      materialize: true,
      applyRunResult: true,
      summarize: true,
      cleanupIssues: true,
      parentChildIssues: true,
    },
  } satisfies Pick<TrackerProvider, 'kind' | 'capabilities'>;

  assert.equal(provider.kind, 'linear-graphql');
  assert.equal(provider.capabilities.parentChildIssues, true);
  assert.equal(provider.capabilities.materialize, true);
  assert.equal(provider.capabilities.summarize, true);
  assert.equal(provider.capabilities.cleanupIssues, true);
});
