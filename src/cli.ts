import { AssetSyncEngine } from './sync/engine.js';
import { OpenCodeSyncAdapter } from './sync/adapters/opencode.js';

async function main() {
  if (process.argv[2] !== 'sync') return;
  const report = await new AssetSyncEngine(OpenCodeSyncAdapter).execute();
  console.log(JSON.stringify(report, null, 2));
}

main();
