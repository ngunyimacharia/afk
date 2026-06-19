import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateSelectedTicketPath } from '../src/path-validation.js';
import type { TicketRecord } from '../src/types.js';

function baseTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    path: '/tmp/ticket.md',
    feature: 'feat',
    issueName: '01',
    label: 'feat/01',
    executorAfk: true,
    ...overrides,
  };
}

test('allows valid scratch ticket path', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, '01.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n');

  const result = validateSelectedTicketPath(repoRoot, baseTicket({ path: ticketPath }));

  assert.equal(result, null);
});

test('blocks scratch ticket outside its feature issues directory', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const wrongDir = path.join(repoRoot, '.scratch', 'other', 'issues');
  mkdirSync(wrongDir, { recursive: true });
  const ticketPath = path.join(wrongDir, '01.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n');

  const result = validateSelectedTicketPath(repoRoot, baseTicket({ path: ticketPath }));

  assert.equal(result?.kind, 'path-validation');
  assert.match(result?.message ?? '', /must be under/);
});

test('allows Linear ticket when parent and issue keys match labels', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const mirrorDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors');
  mkdirSync(mirrorDir, { recursive: true });
  const ticketPath = path.join(mirrorDir, 'fin-141-fin-144.md');
  writeFileSync(ticketPath, '# ticket\n');

  const ticket = baseTicket({
    path: ticketPath,
    source: 'linear',
    feature: 'fin-141',
    issueName: 'fin-144',
    label: 'fin-141/fin-144',
    linear: {
      parentKey: 'FIN-141',
      issueKey: 'FIN-144',
    },
  });

  assert.equal(validateSelectedTicketPath(repoRoot, ticket), null);
});

test('blocks Linear ticket when parent key maps to a different feature', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const mirrorDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors');
  mkdirSync(mirrorDir, { recursive: true });
  const ticketPath = path.join(mirrorDir, 'fin-141-fin-144.md');
  writeFileSync(ticketPath, '# ticket\n');

  const ticket = baseTicket({
    path: ticketPath,
    source: 'linear',
    feature: 'fin-141',
    issueName: 'fin-144',
    label: 'fin-141/fin-144',
    linear: {
      parentKey: 'FIN-142',
      issueKey: 'FIN-144',
    },
  });

  const result = validateSelectedTicketPath(repoRoot, ticket);
  assert.equal(result?.kind, 'linear-identity');
  assert.match(result?.message ?? '', /Linear parent key FIN-142 maps to feature 'fin-142'/);
});

test('blocks Linear ticket when issue key maps to a different issue name', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const mirrorDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors');
  mkdirSync(mirrorDir, { recursive: true });
  const ticketPath = path.join(mirrorDir, 'fin-141-fin-144.md');
  writeFileSync(ticketPath, '# ticket\n');

  const ticket = baseTicket({
    path: ticketPath,
    source: 'linear',
    feature: 'fin-141',
    issueName: 'fin-144',
    label: 'fin-141/fin-144',
    linear: {
      parentKey: 'FIN-141',
      issueKey: 'FIN-145',
    },
  });

  const result = validateSelectedTicketPath(repoRoot, ticket);
  assert.equal(result?.kind, 'linear-identity');
  assert.match(result?.message ?? '', /Linear issue key FIN-145 maps to issue 'fin-145'/);
});
