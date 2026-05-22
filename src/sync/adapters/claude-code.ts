import os from 'node:os';
import path from 'node:path';
import type { AssetCategory, SyncAdapter } from '../types.js';

function claudeCodeConfigRoot(): string {
  return path.join(os.homedir(), '.claude');
}

export const ClaudeCodeSyncAdapter: SyncAdapter = {
  id: 'claude-code',
  assetCategories(): AssetCategory[] {
    const configRoot = claudeCodeConfigRoot();
    return [
      {
        name: 'skills',
        sourceRoot: 'artifacts/skills',
        destinationRoot: path.join(configRoot, 'skills'),
        destinationBase: configRoot,
        extensions: ['.md'],
      },
      {
        name: 'prompts',
        sourceRoot: 'artifacts/prompts',
        destinationRoot: path.join(configRoot, 'prompts'),
        destinationBase: configRoot,
        extensions: ['.md'],
      },
    ];
  },
};
