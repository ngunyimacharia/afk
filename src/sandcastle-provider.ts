import os from 'node:os';
import path from 'node:path';
import type { SelectableHarnessId } from './harness-registry.js';
import { AFK_RUNTIME_PROVIDER_CONFIG_TARGETS } from './sandcastle-runtime-image-contract.js';
import type { LaunchModel, SandboxMode } from './types.js';

export type SandcastleAgentProviderName = 'pi';
export type SandcastleProviderFailureKind = 'missing-auth' | 'invalid-provider' | 'runtime-error';

export interface SandcastleDockerMountRequirement {
  source: string;
  target: string;
  required: boolean;
}

export interface SandcastleAuthRequirement {
  env: string[];
  mounts: SandcastleDockerMountRequirement[];
}

export interface SandcastleAgentProviderSelection {
  provider: SandcastleAgentProviderName;
  model?: string;
  docker: SandcastleAuthRequirement;
  noSandbox?: {
    enabled: true;
    reason: string;
  };
}

export interface SandcastleProviderFailure {
  provider: SandcastleAgentProviderName;
  kind: SandcastleProviderFailureKind;
  message: string;
  missingEnv?: string[];
  missingMounts?: SandcastleDockerMountRequirement[];
}

export interface SandcastleProviderAuthInput {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathExists?: (path: string) => boolean;
}

const DEFAULT_MODEL_IDS = new Set(['default-model', 'reviewer-default-model']);

export function resolveSandcastleAgentProvider(
  harness: SelectableHarnessId,
  model?: LaunchModel,
  input: SandcastleProviderAuthInput = {},
  sandboxMode?: SandboxMode,
): SandcastleAgentProviderSelection {
  const homeDir = input.homeDir ?? os.homedir();
  const modelId = normalizeSandcastleModelId(harness, model?.id);

  return {
    provider: 'pi',
    model: modelId,
    docker: {
      env: [],
      mounts: [{ source: path.join(homeDir, '.pi'), target: AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.pi, required: true }],
    },
    ...(sandboxMode === 'docker'
      ? {}
      : {
          noSandbox: {
            enabled: true as const,
            reason: 'PI no-sandbox mode uses the host PI configuration under ~/.pi.',
          },
        }),
  };
}

export function normalizeSandcastleModelId(
  _harness: SelectableHarnessId,
  modelId: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed || DEFAULT_MODEL_IDS.has(trimmed)) return undefined;
  if (trimmed === 'pi/default') return undefined;
  return trimmed;
}

export function validateSandcastleDockerAuth(
  selection: SandcastleAgentProviderSelection,
  input: SandcastleProviderAuthInput = {},
): SandcastleProviderFailure | null {
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? (() => true);
  const missingEnv = selection.docker.env.filter((name) => !env[name]?.trim());
  const missingMounts = selection.docker.mounts.filter((mount) => mount.required && !pathExists(mount.source));
  if (!missingEnv.length && !missingMounts.length) return null;

  return {
    provider: selection.provider,
    kind: 'missing-auth',
    message: formatMissingAuthMessage(selection.provider, missingEnv, missingMounts),
    missingEnv,
    missingMounts,
  };
}

function formatMissingAuthMessage(
  provider: SandcastleAgentProviderName,
  missingEnv: string[],
  missingMounts: SandcastleDockerMountRequirement[],
): string {
  const parts = [];
  if (missingEnv.length) parts.push(`missing env ${missingEnv.join(', ')}`);
  if (missingMounts.length) parts.push(`missing mount ${missingMounts.map((mount) => mount.source).join(', ')}`);
  return `Sandcastle ${provider} Docker auth is unavailable: ${parts.join('; ')}`;
}
