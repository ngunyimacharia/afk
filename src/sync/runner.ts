import { AssetSyncEngine, formatSyncReport } from './engine.js';
import { OpenCodeSyncAdapter } from './adapters/opencode.js';

export async function runSync(): Promise<{ code: number; message: string }> {
  const engine = new AssetSyncEngine(OpenCodeSyncAdapter);
  const report = await engine.execute();
  return {
    code: 0,
    message: `${formatSyncReport(report)}\nRestart OpenCode for these asset changes to take effect.`,
  };
}
