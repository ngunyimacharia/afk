import os from 'node:os';
import path from 'node:path';
import type { AssetCategory, SyncAdapter } from '../types.js';

function kimiConfigRoot(): string {
  return path.join(os.homedir(), '.kimi');
}

export const KimiSyncAdapter: SyncAdapter = {
  id: 'kimi',
  assetCategories(): AssetCategory[] {
    const configRoot = kimiConfigRoot();
    return [
      {
        name: 'skills',
        sourceRoot: 'artifacts/skills',
        destinationRoot: path.join(configRoot, 'skills'),
        destinationBase: configRoot,
        extensions: ['.md', '.toml', '.json'],
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
