import { ClaudeCodeSyncAdapter } from './adapters/claude-code.js';
import { KimiCodeSyncAdapter } from './adapters/kimi-code.js';
import { OpenCodeSyncAdapter } from './adapters/opencode.js';
import { AssetSyncEngine, formatSyncReport } from './engine.js';
import { ensureAfkGlobalGitIgnore } from './global-git-ignore.js';

export async function runSync(): Promise<{ code: number; message: string }> {
  const opencodeEngine = new AssetSyncEngine(OpenCodeSyncAdapter);
  const opencodeReport = await opencodeEngine.execute();

  const claudeEngine = new AssetSyncEngine(ClaudeCodeSyncAdapter);
  const claudeReport = await claudeEngine.execute();

  const kimiEngine = new AssetSyncEngine(KimiCodeSyncAdapter);
  const kimiReport = await kimiEngine.execute();

  const gitIgnore = await ensureAfkGlobalGitIgnore();
  return {
    code: 0,
    message: [
      formatSyncReport(opencodeReport),
      '',
      formatSyncReport(claudeReport),
      '',
      formatSyncReport(kimiReport),
      '',
      `Git global excludes: ${gitIgnore.excludesFile}`,
      'Restart OpenCode for these asset changes to take effect.',
      'Restart Claude Code for these asset changes to take effect.',
      'Restart Kimi Code for these asset changes to take effect.',
    ].join('\n'),
  };
}
