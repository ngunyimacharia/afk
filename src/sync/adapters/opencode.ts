import os from 'node:os';
import path from 'node:path';
import type { AssetCategory, SyncAdapter } from '../types.js';

function openCodeConfigRoot(): string {
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');
}

export const OpenCodeSyncAdapter: SyncAdapter = {
  id: 'opencode',
  assetCategories(): AssetCategory[] {
    const configRoot = openCodeConfigRoot();
    return [
      {
        name: 'skills',
        sourceRoot: 'artifacts/skills',
        destinationRoot: path.join(configRoot, 'skills'),
        destinationBase: configRoot,
        extensions: ['.md'],
        mapDestination: (fileName, destRoot) => {
          const skillName = path.basename(fileName, path.extname(fileName));
          return path.join(destRoot, skillName, 'SKILL.md');
        },
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
