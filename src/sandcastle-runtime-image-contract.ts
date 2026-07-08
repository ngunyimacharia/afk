import { execFileSync } from 'node:child_process';

export const AFK_RUNTIME_IMAGE = 'afk-runtime:latest';
export const AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY = 'afk.phase-executor.v1';
export const AFK_RUNTIME_WORKTREE_PATH = '/workspace/afk-worktree';

export const AFK_RUNTIME_PROVIDER_CONFIG_TARGETS = {
  opencode: '/home/sandbox/.config/opencode',
  claudeCode: '/home/sandbox/.claude',
  codex: '/home/sandbox/.codex',
} as const;

export type SandcastleRuntimeImageValidationFailureKind = 'missing-image' | 'missing-phase-executor';

export interface SandcastleRuntimeImageValidationFailure {
  kind: SandcastleRuntimeImageValidationFailureKind;
  image: string;
  message: string;
}

export type SandcastleRuntimeImageValidationResult =
  | { ok: true; image: string; capability: typeof AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY }
  | { ok: false; failure: SandcastleRuntimeImageValidationFailure };

export interface SandcastleRuntimeImageClient {
  imageExists(image: string): Promise<boolean>;
  imageExposesCapability(image: string, capability: string): Promise<boolean>;
}

export class DockerSandcastleRuntimeImageClient implements SandcastleRuntimeImageClient {
  imageExists(image: string): Promise<boolean> {
    try {
      execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
      return Promise.resolve(true);
    } catch (_error) {
      return Promise.resolve(false);
    }
  }

  imageExposesCapability(image: string, capability: string): Promise<boolean> {
    try {
      const output = execFileSync('docker', ['run', '--rm', image, 'afk-sandcastle-executor', 'capabilities'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return Promise.resolve(output.split(/\s+/).includes(capability));
    } catch (_error) {
      return Promise.resolve(false);
    }
  }
}

export async function validateSandcastleRuntimeImage(
  client: SandcastleRuntimeImageClient,
  image = AFK_RUNTIME_IMAGE,
): Promise<SandcastleRuntimeImageValidationResult> {
  if (!(await client.imageExists(image))) {
    return {
      ok: false,
      failure: {
        kind: 'missing-image',
        image,
        message: `Sandcastle Docker runtime image ${image} is not available. Build or pull ${AFK_RUNTIME_IMAGE} before launching Docker-isolated AFK runs.`,
      },
    };
  }

  if (!(await client.imageExposesCapability(image, AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY))) {
    return {
      ok: false,
      failure: {
        kind: 'missing-phase-executor',
        image,
        message: `Sandcastle Docker runtime image ${image} does not expose required capability ${AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY}.`,
      },
    };
  }

  return { ok: true, image, capability: AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY };
}
