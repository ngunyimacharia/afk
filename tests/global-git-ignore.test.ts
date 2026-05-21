import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureAfkGlobalGitIgnore } from '../src/sync/global-git-ignore.js';

test('configures git global excludes file and adds AFK repo-local ignores', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'afk-git-ignore-home-'));
  const commands: string[][] = [];

  const result = await ensureAfkGlobalGitIgnore({
    home,
    env: {},
    git: (args) => {
      commands.push(args);
      if (args.includes('--get')) throw new Error('not configured');
      return '';
    },
  });

  assert.equal(result.excludesFile, path.join(home, '.config', 'git', 'ignore'));
  assert.deepEqual(result.added, ['/.scratch/', '/.worktree/', '/afk.json']);
  assert.deepEqual(commands.at(-1), ['config', '--global', 'core.excludesfile', result.excludesFile]);
  assert.equal(await readFile(result.excludesFile, 'utf8'), '/.scratch/\n/.worktree/\n/afk.json\n');
});

test('preserves configured global excludes file and does not duplicate entries', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'afk-git-ignore-home-'));
  const excludesFile = path.join(home, 'custom-ignore');
  await writeFile(excludesFile, '*.log\n/.scratch/\n');

  const first = await ensureAfkGlobalGitIgnore({
    home,
    env: {},
    git: (args) => (args.includes('--get') ? excludesFile : ''),
  });
  const second = await ensureAfkGlobalGitIgnore({
    home,
    env: {},
    git: (args) => (args.includes('--get') ? excludesFile : ''),
  });

  assert.deepEqual(first.added, ['/.worktree/', '/afk.json']);
  assert.deepEqual(second.added, []);
  assert.equal(await readFile(excludesFile, 'utf8'), '*.log\n/.scratch/\n/.worktree/\n/afk.json\n');
});
