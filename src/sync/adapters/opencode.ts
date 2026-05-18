import { AssetCategory, SyncAdapter } from '../types.js';

export const OpenCodeSyncAdapter: SyncAdapter = {
  id: 'opencode',
  assetCategories(): AssetCategory[] {
    return [
      { name: 'sub-agents', sourceRoot: 'PRDs/sub-agents', destinationRoot: 'private_dot_config/opencode/agents', extensions: ['.md'] },
      { name: 'prompts', sourceRoot: 'PRDs/prompts', destinationRoot: 'private_dot_config/opencode/prompts', extensions: ['.md'] },
      { name: 'commands', sourceRoot: 'PRDs/commands', destinationRoot: 'private_dot_config/opencode/command', extensions: ['.md'] },
    ];
  },
};
