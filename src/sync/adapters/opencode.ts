import { AssetCategory, SyncAdapter } from '../types.js';

export const OpenCodeSyncAdapter: SyncAdapter = {
  id: 'opencode',
  assetCategories(): AssetCategory[] {
    return [
      { name: 'agents', sourceRoot: 'artifacts/opencode/agents', destinationRoot: 'private_dot_config/opencode/agents', extensions: ['.md'] },
      { name: 'prompts', sourceRoot: 'artifacts/opencode/prompts', destinationRoot: 'private_dot_config/opencode/prompts', extensions: ['.md'] },
      { name: 'commands', sourceRoot: 'artifacts/opencode/commands', destinationRoot: 'private_dot_config/opencode/command', extensions: ['.md'] },
    ];
  },
};
