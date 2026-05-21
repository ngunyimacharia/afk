import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { SyncActionStatus, SyncAdapter, SyncReport } from './types.js';

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

function ensureWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Destination path escapes root: ${candidate}`);
  }
}

async function readIfFile(filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  return fs.readFile(filePath, 'utf8');
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  return fs.access(directoryPath, constants.R_OK).then(
    () => true,
    () => false,
  );
}

export class AssetSyncEngine {
  constructor(private readonly adapter: SyncAdapter) {}

  async plan(): Promise<SyncReport> {
    const actions: SyncReport['actions'] = [];
    for (const category of this.adapter.assetCategories()) {
      const sourceRoot = normalizeRoot(category.sourceRoot);
      const destinationRoot = normalizeRoot(category.destinationRoot);
      if (category.destinationBase) {
        ensureWithinRoot(normalizeRoot(category.destinationBase), destinationRoot);
      }
      if (!(await directoryExists(sourceRoot))) continue;
      await fs.mkdir(destinationRoot, { recursive: true });
      const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (category.extensions && !category.extensions.some((ext) => entry.name.endsWith(ext))) {
          actions.push({
            category: category.name,
            sourcePath: path.join(sourceRoot, entry.name),
            destinationPath: path.join(destinationRoot, entry.name),
            status: 'skipped',
          });
          continue;
        }
        const sourcePath = path.join(sourceRoot, entry.name);
        if (category.validateSource) await category.validateSource(sourcePath);
        const destinationPath = path.join(destinationRoot, entry.name);
        ensureWithinRoot(destinationRoot, destinationPath);
        const sourceContent = await fs.readFile(sourcePath, 'utf8');
        const existing = await readIfFile(destinationPath);
        const status: SyncActionStatus =
          existing === null ? 'created' : existing === sourceContent ? 'unchanged' : 'updated';
        actions.push({ category: category.name, sourcePath, destinationPath, status });
      }
    }
    return { adapterId: this.adapter.id, actions, counts: countActions(actions) };
  }

  async execute(): Promise<SyncReport> {
    const report = await this.plan();
    for (const action of report.actions) {
      if (action.status === 'created' || action.status === 'updated') {
        await fs.mkdir(path.dirname(action.destinationPath), { recursive: true });
        await fs.copyFile(action.sourcePath, action.destinationPath);
      }
    }
    return report;
  }
}

export function formatSyncReport(report: SyncReport): string {
  const lines = [
    `Adapter: ${report.adapterId}`,
    `Created: ${report.counts.created}`,
    `Updated: ${report.counts.updated}`,
    `Unchanged: ${report.counts.unchanged}`,
    `Skipped: ${report.counts.skipped}`,
  ];
  for (const action of report.actions) {
    lines.push(`${action.status.toUpperCase()} ${action.category}: ${action.sourcePath} -> ${action.destinationPath}`);
  }
  return lines.join('\n');
}

function countActions(actions: SyncReport['actions']): SyncReport['counts'] {
  const counts: SyncReport['counts'] = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const action of actions) counts[action.status] += 1;
  return counts;
}
