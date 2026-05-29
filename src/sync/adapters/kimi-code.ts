import os from 'node:os';
import path from 'node:path';
import type { AssetCategory, SyncAdapter } from '../types.js';

function kimiCodeConfigRoot(): string {
  return process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), '.kimi-code');
}

export const KimiCodeSyncAdapter: SyncAdapter = {
  id: 'kimi-code',
  assetCategories(): AssetCategory[] {
    const configRoot = kimiCodeConfigRoot();
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
    ];
  },
};
