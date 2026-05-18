import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SummaryReporter } from '../src/summary-reporter.js';

test('summary reporter requests raw-log permission when configured', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  let requested = false;
  const report = await new SummaryReporter({
    repoRoot,
    permission: {
      async request() {
        requested = true;
        return false;
      },
    },
  }).summarize();
  assert.equal(requested, true);
  assert.match(report.message, /Raw logs were not inspected/);
});
