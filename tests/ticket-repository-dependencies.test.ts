import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TicketRepository } from '../src/ticket-repository.js';

test('parses Depends-On frontmatter values', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    '---\nfeature: feat\nstatus: ready-for-agent\nDepends-On:\n  - 02\n  - 03\n---\n',
  );
  const repository = new TicketRepository(repoRoot);
  const ticket = repository.readTicket(path.join(issuesDir, '01.md'));
  assert.deepEqual(ticket.dependsOn, ['02', '03']);
});

test('parses scalar Depends-On and tolerates empty values', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nDepends-On: 02\n---\n');
  writeFileSync(path.join(issuesDir, '02.md'), '---\nfeature: feat\nDepends-On: []\n---\n');
  const repository = new TicketRepository(repoRoot);
  assert.deepEqual(repository.readTicket(path.join(issuesDir, '01.md')).dependsOn, ['02']);
  assert.deepEqual(repository.readTicket(path.join(issuesDir, '02.md')).dependsOn, []);
});
