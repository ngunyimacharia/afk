import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SummaryReporter } from '../src/summary-reporter.js';
import type { RawLogPermissionRequest } from '../src/summary-reporter.js';

test('summary reporter requests raw-log permission when configured', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  let requested = false;
  let requestScope = '';
  let requestReason = '';
  const report = await new SummaryReporter({
    repoRoot,
    permission: {
      async request(args: RawLogPermissionRequest) {
        requested = true;
        requestScope = args.scope;
        requestReason = args.reason;
        return false;
      },
    },
  }).summarize();
  assert.equal(requested, true);
  assert.equal(requestScope, '.scratch/.opencode-afk-logs/');
  assert.match(requestReason, /missing summaries|incomplete|contradictory/i);
  assert.match(report.message, /Raw logs were not inspected/);
});
