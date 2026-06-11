import { ClaudeCodeSyncAdapter } from './adapters/claude-code.js';
import { CodexSyncAdapter } from './adapters/codex.js';
import { KimiCodeSyncAdapter } from './adapters/kimi-code.js';
import { OpenCodeSyncAdapter } from './adapters/opencode.js';
import { AssetSyncEngine, formatSyncReport } from './engine.js';
import { ensureAfkGlobalGitIgnore } from './global-git-ignore.js';
import type { SyncAdapter } from './types.js';

export const SyncAdapters: SyncAdapter[] = [
  OpenCodeSyncAdapter,
  ClaudeCodeSyncAdapter,
  KimiCodeSyncAdapter,
  CodexSyncAdapter,
];

export async function runSync(): Promise<{ code: number; message: string }> {
  const reports = [];
  for (const adapter of SyncAdapters) {
    reports.push(await new AssetSyncEngine(adapter).execute());
  }

  const gitIgnore = await ensureAfkGlobalGitIgnore();
  return {
    code: 0,
    message: [
      reports.map(formatSyncReport).join('\n\n'),
      '',
      `Git global excludes: ${gitIgnore.excludesFile}`,
      'Restart OpenCode for these asset changes to take effect.',
      'Restart Claude Code for these asset changes to take effect.',
      'Restart Kimi Code for these asset changes to take effect.',
      'Codex normally detects skill changes automatically; restart Codex if changes do not appear.',
    ].join('\n'),
  };
}
