import {
  type AgentExecutionProvider,
  ClaudeAgentExecutionProvider,
  CodexAgentExecutionProvider,
  OpenCodeAgentExecutionProvider,
} from './agent-execution-provider.js';
import { ClaudeCodeSessionExecutor, discoverClaudeModels } from './claude-code.js';
import { CodexSessionExecutor, discoverCodexModels } from './codex.js';
import { discoverOpenCodeModels, type OpenCodeSessionExecutor, SDKOpenCodeSessionExecutor } from './opencode.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { LaunchModel } from './types.js';

export type HarnessId = 'OpenCode' | 'Claude' | 'Codex';
export type SelectableHarnessId = HarnessId;

interface HarnessRegistryEntry {
  id: HarnessId;
  displayName: string;
  providerName: string;
  selectable: boolean;
  discoverModels?: (repoRoot?: string) => Promise<LaunchModel[]>;
  createExecutor?: (repoRoot?: string) => OpenCodeSessionExecutor;
  createAgentExecutionProvider?: (
    executor: OpenCodeSessionExecutor,
    permissionCoordinator?: PermissionCoordinator,
  ) => AgentExecutionProvider;
}

const HARNESS_REGISTRY = [
  {
    id: 'OpenCode',
    displayName: 'OpenCode',
    providerName: 'opencode',
    selectable: true,
    discoverModels: discoverOpenCodeModels,
    createExecutor: () => new SDKOpenCodeSessionExecutor(),
    createAgentExecutionProvider: (executor, permissionCoordinator) =>
      new OpenCodeAgentExecutionProvider(executor, permissionCoordinator),
  },
  {
    id: 'Claude',
    displayName: 'Claude',
    providerName: 'claude',
    selectable: true,
    discoverModels: discoverClaudeModels,
    createExecutor: (repoRoot) => new ClaudeCodeSessionExecutor(repoRoot ?? process.cwd()),
    createAgentExecutionProvider: (executor, permissionCoordinator) =>
      new ClaudeAgentExecutionProvider(executor, permissionCoordinator),
  },
  {
    id: 'Codex',
    displayName: 'Codex',
    providerName: 'codex',
    selectable: true,
    discoverModels: (repoRoot) => discoverCodexModels(process.env, repoRoot),
    createExecutor: () => new CodexSessionExecutor(),
    createAgentExecutionProvider: (executor, permissionCoordinator) =>
      new CodexAgentExecutionProvider(executor, permissionCoordinator),
  },
] satisfies HarnessRegistryEntry[];

const HARNESS_BY_ID = new Map<HarnessId, HarnessRegistryEntry>(HARNESS_REGISTRY.map((entry) => [entry.id, entry]));

export function isHarnessId(value: string): value is HarnessId {
  return HARNESS_BY_ID.has(value as HarnessId);
}

export function isSelectableHarnessId(value: string): value is SelectableHarnessId {
  const entry = HARNESS_BY_ID.get(value as HarnessId);
  return !!entry?.selectable;
}

export function selectableHarnessIds(): SelectableHarnessId[] {
  return HARNESS_REGISTRY.filter((entry) => entry.selectable).map((entry) => entry.id as SelectableHarnessId);
}

export async function discoverAvailableHarnesses(
  discoverModels: (harness: SelectableHarnessId, repoRoot?: string) => Promise<LaunchModel[]> = discoverHarnessModels,
  repoRoot?: string,
): Promise<{
  availableHarnesses: SelectableHarnessId[];
  harnessModelCache: Partial<Record<SelectableHarnessId, LaunchModel[]>>;
}> {
  const availableHarnesses: SelectableHarnessId[] = [];
  const harnessModelCache: Partial<Record<SelectableHarnessId, LaunchModel[]>> = {};
  for (const harness of selectableHarnessIds()) {
    try {
      const models = await discoverModels(harness, repoRoot);
      if (!models.length) continue;
      availableHarnesses.push(harness);
      harnessModelCache[harness] = models;
    } catch {
      // Harness discovery failures mean this harness is unavailable for launch.
    }
  }
  return { availableHarnesses, harnessModelCache };
}

export async function discoverHarnessModels(harness: SelectableHarnessId, repoRoot?: string): Promise<LaunchModel[]> {
  const discoverModels = HARNESS_BY_ID.get(harness)?.discoverModels;
  return discoverModels ? discoverModels(repoRoot) : [];
}

export function createHarnessExecutor(harness: SelectableHarnessId, repoRoot?: string): OpenCodeSessionExecutor {
  const createExecutor = HARNESS_BY_ID.get(harness)?.createExecutor;
  if (!createExecutor) throw new Error(`Harness is not executable: ${harness}`);
  return createExecutor(repoRoot);
}

export function createHarnessAgentExecutionProvider(
  harness: SelectableHarnessId,
  executor: OpenCodeSessionExecutor,
  permissionCoordinator?: PermissionCoordinator,
): AgentExecutionProvider {
  const createProvider = HARNESS_BY_ID.get(harness)?.createAgentExecutionProvider;
  if (!createProvider) throw new Error(`Harness provider is not available: ${harness}`);
  return createProvider(executor, permissionCoordinator);
}

export function displayNameForHarness(harness: HarnessId): string {
  return HARNESS_BY_ID.get(harness)?.displayName ?? harness;
}

export function providerNameForHarness(harness: HarnessId): string {
  return HARNESS_BY_ID.get(harness)?.providerName ?? harness.toLowerCase();
}

export function migrateLegacyHarnessId(value: string): string {
  if (value === 'Claude-Kimi') return 'Claude';
  return value;
}

export function migrateLegacyProviderName(value: string): string {
  if (value === 'claude-kimi') return 'claude';
  return value;
}
