import os from 'node:os';
import path from 'node:path';
import type { AssetCategory, SyncAdapter } from '../types.js';

function codexSkillsRoot(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

export const CodexSyncAdapter: SyncAdapter = {
  id: 'codex',
  assetCategories(): AssetCategory[] {
    const skillsRoot = codexSkillsRoot();
    return [
      {
        name: 'skills',
        sourceRoot: 'artifacts/skills',
        destinationRoot: skillsRoot,
        destinationBase: skillsRoot,
        extensions: ['.md'],
        mapDestination: (fileName, destRoot) => {
          const skillName = path.basename(fileName, path.extname(fileName));
          return path.join(destRoot, skillName, 'SKILL.md');
        },
      },
    ];
  },
};
