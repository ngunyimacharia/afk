import {
  type AgentExecutionProvider,
  ClaudeKimiAgentExecutionProvider,
  CodexAgentExecutionProvider,
  OpenCodeAgentExecutionProvider,
} from './agent-execution-provider.js';
import { ClaudeCodeSessionExecutor, discoverClaudeKimiModels } from './claude-code.js';
import { CodexSessionExecutor, discoverCodexModels } from './codex.js';
import { type OpenCodeSessionExecutor, discoverOpenCodeModels, SDKOpenCodeSessionExecutor } from './opencode.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { LaunchModel } from './types.js';

export type HarnessId = 'OpenCode' | 'Claude-Kimi' | 'Codex';
export type SelectableHarnessId = HarnessId;

interface HarnessRegistryEntry {
  id: HarnessId;
  displayName: string;
  providerName: string;
  selectable: boolean;
  discoverModels?: () => Promise<LaunchModel[]>;
  createExecutor?: () => OpenCodeSessionExecutor;
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
    id: 'Claude-Kimi',
    displayName: 'Claude-Kimi',
    providerName: 'claude-kimi',
    selectable: true,
    discoverModels: discoverClaudeKimiModels,
    createExecutor: () => new ClaudeCodeSessionExecutor('kimi'),
    createAgentExecutionProvider: (executor, permissionCoordinator) =>
      new ClaudeKimiAgentExecutionProvider(executor, permissionCoordinator),
  },
  {
    id: 'Codex',
    displayName: 'Codex',
    providerName: 'codex',
    selectable: true,
    discoverModels: discoverCodexModels,
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
  discoverModels: (harness: SelectableHarnessId) => Promise<LaunchModel[]> = discoverHarnessModels,
): Promise<{
  availableHarnesses: SelectableHarnessId[];
  harnessModelCache: Partial<Record<SelectableHarnessId, LaunchModel[]>>;
}> {
  const availableHarnesses: SelectableHarnessId[] = [];
  const harnessModelCache: Partial<Record<SelectableHarnessId, LaunchModel[]>> = {};
  for (const harness of selectableHarnessIds()) {
    try {
      const models = await discoverModels(harness);
      if (!models.length) continue;
      availableHarnesses.push(harness);
      harnessModelCache[harness] = models;
    } catch {
      // Harness discovery failures mean this harness is unavailable for launch.
    }
  }
  return { availableHarnesses, harnessModelCache };
}

export async function discoverHarnessModels(harness: SelectableHarnessId): Promise<LaunchModel[]> {
  const discoverModels = HARNESS_BY_ID.get(harness)?.discoverModels;
  return discoverModels ? discoverModels() : [];
}

export function createHarnessExecutor(harness: SelectableHarnessId): OpenCodeSessionExecutor {
  const createExecutor = HARNESS_BY_ID.get(harness)?.createExecutor;
  if (!createExecutor) throw new Error(`Harness is not executable: ${harness}`);
  return createExecutor();
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
