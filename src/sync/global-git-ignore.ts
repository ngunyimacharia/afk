import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AFK_GLOBAL_GIT_IGNORE_ENTRIES = ['/.scratch/', '/.worktree/'];

type GitCommand = (args: string[], env: NodeJS.ProcessEnv) => string;

function runGit(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function expandHome(filePath: string, home: string): string {
  if (filePath === '~') return home;
  if (filePath.startsWith('~/')) return path.join(home, filePath.slice(2));
  return filePath;
}

function defaultExcludesFile(home: string, env: NodeJS.ProcessEnv): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdgConfigHome || path.join(home, '.config'), 'git', 'ignore');
}

export async function ensureAfkGlobalGitIgnore(input: { home?: string; env?: NodeJS.ProcessEnv; git?: GitCommand } = {}): Promise<{ excludesFile: string; added: string[] }> {
  const home = input.home ?? os.homedir();
  const env = input.env ?? process.env;
  const git = input.git ?? runGit;
  let configuredExcludesFile = '';
  try {
    configuredExcludesFile = git(['config', '--global', '--get', 'core.excludesfile'], env).trim();
  } catch {
    configuredExcludesFile = '';
  }

  const excludesFile = path.resolve(expandHome(configuredExcludesFile || defaultExcludesFile(home, env), home));
  if (!configuredExcludesFile) git(['config', '--global', 'core.excludesfile', excludesFile], env);

  await fs.mkdir(path.dirname(excludesFile), { recursive: true });
  const current = await fs.readFile(excludesFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const added = AFK_GLOBAL_GIT_IGNORE_ENTRIES.filter((entry) => !existing.has(entry));
  if (added.length) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    await fs.writeFile(excludesFile, `${current}${prefix}${added.join('\n')}\n`, 'utf8');
  }
  return { excludesFile, added };
}
