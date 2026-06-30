import { spawnSync } from 'node:child_process';

type DockerProbe = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => { error?: unknown; status: number | null };

export function detectDockerAvailable(probe: DockerProbe = spawnSync as DockerProbe): boolean {
  const result = probe('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
  return !result.error && result.status === 0;
}
