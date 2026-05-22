import { KimiSyncAdapter } from './adapters/kimi.js';
import { OpenCodeSyncAdapter } from './adapters/opencode.js';
import { AssetSyncEngine, formatSyncReport } from './engine.js';
import { ensureAfkGlobalGitIgnore } from './global-git-ignore.js';

export async function runSync(): Promise<{ code: number; message: string }> {
  const opencodeEngine = new AssetSyncEngine(OpenCodeSyncAdapter);
  const opencodeReport = await opencodeEngine.execute();

  const kimiEngine = new AssetSyncEngine(KimiSyncAdapter);
  const kimiReport = await kimiEngine.execute();

  const gitIgnore = await ensureAfkGlobalGitIgnore();
  return {
    code: 0,
    message: [
      formatSyncReport(opencodeReport),
      '',
      formatSyncReport(kimiReport),
      '',
      `Git global excludes: ${gitIgnore.excludesFile}`,
      'Restart OpenCode for these asset changes to take effect.',
      'Restart Kimi for these asset changes to take effect.',
    ].join('\n'),
  };
}
