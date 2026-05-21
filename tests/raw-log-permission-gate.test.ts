import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RawLogPermissionRequest } from '../src/summary-reporter.js';
import { SummaryReporter } from '../src/summary-reporter.js';

test('summary reporter requests raw-log permission when configured', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  let requested = false;
  const requests: RawLogPermissionRequest[] = [];
  const report = await new SummaryReporter({
    repoRoot,
    permission: {
      async request(args) {
        requested = true;
        requests.push(args);
        return false;
      },
    },
  }).summarize();
  assert.equal(requested, true);
  const requestArgs = requests[0];
  if (!requestArgs) throw new Error('expected permission request args');
  assert.equal(requestArgs.scope, '.scratch/.opencode-afk-logs/');
  assert.match(requestArgs.reason, /missing summaries|incomplete|contradictory/i);
  assert.match(report.message, /Raw logs were not inspected/);
});
