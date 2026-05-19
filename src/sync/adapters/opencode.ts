import os from 'node:os';
import path from 'node:path';
import { AssetCategory, SyncAdapter } from '../types.js';

function openCodeConfigRoot(): string {
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');
}

export const OpenCodeSyncAdapter: SyncAdapter = {
  id: 'opencode',
  assetCategories(): AssetCategory[] {
    const configRoot = openCodeConfigRoot();
    return [
      { name: 'agents', sourceRoot: 'artifacts/opencode/agents', destinationRoot: path.join(configRoot, 'agents'), destinationBase: configRoot, extensions: ['.md'] },
      { name: 'prompts', sourceRoot: 'artifacts/opencode/prompts', destinationRoot: path.join(configRoot, 'prompts'), destinationBase: configRoot, extensions: ['.md'] },
      { name: 'commands', sourceRoot: 'artifacts/opencode/commands', destinationRoot: path.join(configRoot, 'command'), destinationBase: configRoot, extensions: ['.md'] },
    ];
  },
};
