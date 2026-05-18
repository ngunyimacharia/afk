import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TicketRepository } from '../src/ticket-repository.js';

test('parses frontmatter status and eligibility', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: ready-for-agent\n---\n');
  const repository = new TicketRepository(repoRoot);
  const ticket = repository.readTicket(path.join(issuesDir, '01.md'));
  assert.equal(ticket.status, 'ready-for-agent');
  assert.equal(repository.isEligible(ticket), true);
});

test('parses legacy status and terminal exclusion', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '02.md'), 'Status: ready-for-human\n');
  const repository = new TicketRepository(repoRoot);
  const ticket = repository.readTicket(path.join(issuesDir, '02.md'));
  assert.equal(ticket.status, 'ready-for-human');
  assert.equal(repository.isEligible(ticket), false);
});
