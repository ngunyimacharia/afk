import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

export function mkRepoLocalTempDir(prefix: string): string {
  const root = path.join(process.cwd(), '.test-tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
}
