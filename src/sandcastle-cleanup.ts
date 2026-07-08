import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandcastleCleanupResult } from './sandcastle-runtime-store.js';

const execFileAsync = promisify(execFile);

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

class DefaultSandcastleDockerCleanup implements SandcastleDockerCleanup {
  async removeContainer(
    identity: DockerContainerIdentity,
  ): Promise<{ status: 'succeeded' | 'skipped' | 'failed'; message?: string }> {
    const target = identity.containerId ?? identity.containerName;
    if (!target)
      return { status: 'skipped', message: `Docker cleanup skipped: no container identity for ${identity.image}` };
    try {
      await execFileAsync('docker', ['rm', '-f', target]);
      return { status: 'succeeded', message: `Removed Docker container ${target}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to remove Docker container ${target}`;
      return { status: 'failed', message };
    }
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
