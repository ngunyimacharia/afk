import { AssetSyncEngine, formatSyncReport } from './engine.js';
import { OpenCodeSyncAdapter } from './adapters/opencode.js';
import { ensureAfkGlobalGitIgnore } from './global-git-ignore.js';

export async function runSync(): Promise<{ code: number; message: string }> {
  const engine = new AssetSyncEngine(OpenCodeSyncAdapter);
  const report = await engine.execute();
  const gitIgnore = await ensureAfkGlobalGitIgnore();
  return {
    code: 0,
    message: `${formatSyncReport(report)}\nGit global excludes: ${gitIgnore.excludesFile}\nRestart OpenCode for these asset changes to take effect.`,
  };
}
