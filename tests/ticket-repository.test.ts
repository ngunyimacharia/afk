import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test('rejects legacy status-only tickets', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '02.md'), 'Status: ready-for-human\n');
  const repository = new TicketRepository(repoRoot);
  assert.throws(() => repository.readTicket(path.join(issuesDir, '02.md')), /legacy Status line/);
});

test('derives featureTitle from PRD first heading during discovery', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'my-feature');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(featureDir, 'PRD.md'), '# My Feature Title\n\nSome description.\n');
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: my-feature\nstatus: ready-for-agent\n---\n');

  const tickets = new TicketRepository(repoRoot).discoverTickets();

  assert.equal(tickets.length, 1);
  assert.equal(tickets[0]?.featureTitle, 'My Feature Title');
});

test('strips markdown links and emphasis from PRD heading title', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'my-feature');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(featureDir, 'PRD.md'), '# **[My](url) _Feature_ `Title`**\n\nDescription.\n');
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: my-feature\nstatus: ready-for-agent\n---\n');

  const tickets = new TicketRepository(repoRoot).discoverTickets();

  assert.equal(tickets[0]?.featureTitle, 'My Feature Title');
});

test('leaves featureTitle undefined when PRD heading is missing', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'my-feature');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(featureDir, 'PRD.md'), 'No heading here.\n');
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: my-feature\nstatus: ready-for-agent\n---\n');

  const tickets = new TicketRepository(repoRoot).discoverTickets();

  assert.equal(tickets[0]?.featureTitle, undefined);
});
