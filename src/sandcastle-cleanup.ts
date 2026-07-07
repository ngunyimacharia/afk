import type { SandcastleCleanupResult } from './sandcastle-runtime-store.js';

export interface DockerContainerIdentity {
  image: string;
  containerName?: string;
  containerId?: string;
}

export interface SandcastleDockerCleanup {
  removeContainer(identity: DockerContainerIdentity): Promise<{
    status: 'succeeded' | 'skipped' | 'failed';
    message?: string;
  }>;
}

function defaultSkippedMessage(identity: DockerContainerIdentity): string {
  const target = identity.containerName ?? identity.containerId ?? identity.image;
  return `Docker container ${target} cleanup skipped: @ai-hero/sandcastle is not configured`;
}

class DefaultSandcastleDockerCleanup implements SandcastleDockerCleanup {
  async removeContainer(
    identity: DockerContainerIdentity,
  ): Promise<{ status: 'succeeded' | 'skipped' | 'failed'; message?: string }> {
    return { status: 'skipped', message: defaultSkippedMessage(identity) };
  }
}

let _defaultDockerCleanup: SandcastleDockerCleanup = new DefaultSandcastleDockerCleanup();

export function getDefaultSandcastleDockerCleanup(): SandcastleDockerCleanup {
  return _defaultDockerCleanup;
}

export function setDefaultSandcastleDockerCleanup(cleanup: SandcastleDockerCleanup): void {
  _defaultDockerCleanup = cleanup;
}

export function resetDefaultSandcastleDockerCleanup(): void {
  _defaultDockerCleanup = new DefaultSandcastleDockerCleanup();
}

export function toCleanupResult(
  identity: DockerContainerIdentity,
  outcome: { status: 'succeeded' | 'skipped' | 'failed'; message?: string },
): SandcastleCleanupResult {
  return {
    resourceId: dockerContainerResourceId(identity),
    resourceType: 'docker-container',
    status: outcome.status,
    message: outcome.message,
    updatedAt: new Date().toISOString(),
  };
}

export function dockerContainerResourceId(identity: DockerContainerIdentity): string {
  return identity.containerName ?? identity.containerId ?? identity.image;
}

export function dockerCleanupCommand(identity: DockerContainerIdentity): string {
  const target = identity.containerName ?? identity.containerId ?? identity.image;
  return `docker rm -f ${target}`;
}
