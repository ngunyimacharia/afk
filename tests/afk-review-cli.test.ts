import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

test('afk prints only the reviewer model and final review outcome', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-cli-review-'));
  mkdirSync(path.join(repoRoot, 'src', 'prompts'), { recursive: true });
  mkdirSync(path.join(repoRoot, '.scratch', 'feat', 'issues'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'prompts', 'reviewer-default.md'), '# reviewer\n');
  writeFileSync(path.join(repoRoot, '.scratch', 'feat', 'issues', '001.md'), `---
feature: feat
status: ready-for-agent
executor: afk
---

## Ticket

Work item.
`);

  git(repoRoot, ['init']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'initial']);

  const originalArg = process.argv[2];
  process.argv[2] = 'afk';
  let result: Awaited<ReturnType<typeof runAfk>> | undefined;
  try {
    result = await runAfk(repoRoot);
  } finally {
    process.argv[2] = originalArg;
  }

  assert.ok(result);
  assert.equal(result.code, 0);
  assert.equal(result.message.split('\n').length, 2);
  assert.match(result.message, /Reviewer model: reviewer-default-model/);
  assert.match(result.message, /Final review outcome: needs-human/);
  assert.doesNotMatch(result.message, /Selected tickets|Repo root|Worktree|Branch|Recent git|Reviewer prompt/);
});
