import os from 'node:os';
import path from 'node:path';
import type { AssetCategory, SyncAdapter } from '../types.js';

function piAgentRoot(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}

export const PiSyncAdapter: SyncAdapter = {
  id: 'pi',
  assetCategories(): AssetCategory[] {
    const agentRoot = piAgentRoot();
    return [
      {
        name: 'skills',
        sourceRoot: 'artifacts/skills',
        destinationRoot: path.join(agentRoot, 'skills'),
        destinationBase: agentRoot,
        extensions: ['.md'],
        mapDestination: (fileName, destRoot) => {
          const skillName = path.basename(fileName, path.extname(fileName));
          return path.join(destRoot, skillName, 'SKILL.md');
        },
      },
      {
        name: 'prompts',
        sourceRoot: 'artifacts/prompts',
        destinationRoot: path.join(agentRoot, 'prompts'),
        destinationBase: agentRoot,
        extensions: ['.md'],
      },
    ];
  },
};
