import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SummaryReporter } from '../src/summary-reporter.js';

test('extracts repeated summary blocks and missing summaries', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), `---
feature: feat
status: ready-for-agent
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Outcome: completed

## AFK Summary
Timestamp: 2026-05-18T01:00:00.000Z
Outcome: completed
`);
  writeFileSync(path.join(issuesDir, '02.md'), 'Status: ready-for-agent\n');

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /feat\/01/);
  assert.match(report.message, /2 attempts/);
  assert.match(report.message, /Missing summaries/);
  assert.match(report.message, /feat\/02/);
});
