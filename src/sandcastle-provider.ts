import os from 'node:os';
import path from 'node:path';
import type { SelectableHarnessId } from './harness-registry.js';
import { AFK_RUNTIME_PROVIDER_CONFIG_TARGETS } from './sandcastle-runtime-image-contract.js';
import type { LaunchModel } from './types.js';

export type SandcastleAgentProviderName = 'opencode' | 'claudeCode' | 'codex' | 'pi';
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
  noSandbox: {
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
): SandcastleAgentProviderSelection {
  const homeDir = input.homeDir ?? os.homedir();
  const configRoot = input.env?.XDG_CONFIG_HOME?.trim() || path.join(homeDir, '.config');
  const modelId = normalizeSandcastleModelId(harness, model?.id);

  if (harness === 'OpenCode') {
    return {
      provider: 'opencode',
      model: modelId,
      docker: {
        env: ['OPENCODE_AUTH'],
        mounts: [
          {
            source: path.join(configRoot, 'opencode'),
            target: AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.opencode,
            required: true,
          },
        ],
      },
      noSandbox: { enabled: true, reason: 'OpenCode can run on the prepared worktree without container isolation.' },
    };
  }

  if (harness === 'Claude') {
    return {
      provider: 'claudeCode',
      model: modelId,
      docker: {
        env: ['ANTHROPIC_API_KEY'],
        mounts: [
          {
            source: path.join(homeDir, '.claude'),
            target: AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.claudeCode,
            required: true,
          },
        ],
      },
      noSandbox: {
        enabled: true,
        reason: 'Claude Code no-sandbox mode uses host credentials and bypasses Docker isolation.',
      },
    };
  }

  if (harness === 'PI') {
    return {
      provider: 'pi',
      model: modelId,
      docker: {
        env: ['PI_API_KEY'],
        mounts: [{ source: path.join(homeDir, '.pi'), target: '/home/sandbox/.pi', required: true }],
      },
      noSandbox: {
        enabled: true,
        reason: 'PI no-sandbox mode uses the host PI configuration under ~/.pi.',
      },
    };
  }

  return {
    provider: 'codex',
    model: modelId,
    docker: {
      env: ['OPENAI_API_KEY'],
      mounts: [
        { source: path.join(homeDir, '.codex'), target: AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.codex, required: true },
      ],
    },
    noSandbox: { enabled: true, reason: 'Codex no-sandbox mode uses the host Codex configuration directly.' },
  };
}

export function normalizeSandcastleModelId(
  harness: SelectableHarnessId,
  modelId: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed || DEFAULT_MODEL_IDS.has(trimmed)) return undefined;
  if (harness === 'Codex' && trimmed === 'codex/default') return undefined;
  if (harness === 'PI' && trimmed === 'pi/default') return undefined;
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
