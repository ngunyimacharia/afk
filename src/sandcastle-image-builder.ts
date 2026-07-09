import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveProjectImageTag(repoRoot: string): string {
  const hash = Buffer.from(repoRoot).toString('base64').slice(0, 16).replace(/[+/=]/g, '');
  return `afk-runtime:${hash}`;
}

export function detectLaravel(repoRoot: string): boolean {
  const artisanExists = existsSync(path.join(repoRoot, 'artisan')) || existsSync(path.join(repoRoot, 'artisan.php'));
  const composerExists = existsSync(path.join(repoRoot, 'composer.json'));
  return artisanExists && composerExists;
}

export function extractPhpVersion(repoRoot: string): string | null {
  const composerPath = path.join(repoRoot, 'composer.json');
  if (!existsSync(composerPath)) return null;

  try {
    const raw = readFileSync(composerPath, 'utf8');
    const composer = JSON.parse(raw) as Record<string, unknown>;
    const requireBlock = composer.require as Record<string, string> | undefined;
    if (!requireBlock || typeof requireBlock.php !== 'string') return null;

    const version = requireBlock.php;
    const match = version.match(/(\d+)\.(\d+)/);
    if (match) return `${match[1]}.${match[2]}`;
    return '8.3';
  } catch {
    return null;
  }
}

export function generateDefaultDockerfile(workDir: string): string {
  const dockerfilePath = path.join(workDir, 'AfkRuntimeImagefile');
  const content = `FROM node:22-alpine

RUN apk add --no-cache git bash curl

RUN npm install -g @mariozechner/pi-coding-agent

RUN adduser -D -h /home/sandbox sandbox && \\
    adduser -D -h /home/agent agent && \\
    adduser agent sandbox && \\
    chown -R agent:agent /home/agent && \\
    chmod 777 /home/agent

RUN mkdir -p /workspace/afk-worktree && chmod 777 /workspace/afk-worktree

RUN printf '#!/bin/sh\\ncase "$1" in\\n  capabilities) echo "afk.phase-executor.v1" ;;\\n  *) echo "unknown command: $1" >&2; exit 1 ;;\\nesac\\n' > /usr/local/bin/afk-sandcastle-executor && chmod 755 /usr/local/bin/afk-sandcastle-executor

WORKDIR /home/agent
`;
  writeFileSync(dockerfilePath, content, 'utf8');
  return dockerfilePath;
}

export function generateLaravelDockerfile(workDir: string, phpVersion: string): string {
  const dockerfilePath = path.join(workDir, 'AfkRuntimeImagefile');
  const content = `FROM php:${phpVersion}-cli

RUN apt-get update && apt-get install -y \\
    git bash curl gnupg \\
    libpq-dev libzip-dev \\
    && docker-php-ext-install pdo pdo_mysql pdo_pgsql \\
    && pecl install redis && docker-php-ext-enable redis \\
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
    && apt-get install -y nodejs \\
    && rm -rf /var/lib/apt/lists/*

RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

RUN npm install -g @mariozechner/pi-coding-agent

RUN useradd -m -d /home/sandbox sandbox && \\
    useradd -m -d /home/agent agent && \\
    usermod -a -G sandbox agent && \\
    chmod 777 /home/agent

RUN mkdir -p /workspace/afk-worktree && chmod 777 /workspace/afk-worktree

RUN printf '#!/bin/sh\\ncase "$1" in\\n  capabilities) echo "afk.phase-executor.v1" ;;\\n  *) echo "unknown command: $1" >&2; exit 1 ;;\\nesac\\n' > /usr/local/bin/afk-sandcastle-executor && chmod 755 /usr/local/bin/afk-sandcastle-executor

WORKDIR /home/agent
`;
  writeFileSync(dockerfilePath, content, 'utf8');
  return dockerfilePath;
}

export function buildImage(
  dockerfilePath: string,
  imageTag: string,
  contextDir: string,
): { ok: boolean; message?: string } {
  const result = spawnSync('docker', ['build', '-t', imageTag, '-f', dockerfilePath, contextDir], {
    timeout: 180000,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || '';
    const stdout = result.stdout?.toString() || '';
    return { ok: false, message: stderr || stdout || `docker build exited with code ${result.status}` };
  }

  return { ok: true };
}

export function ensureRuntimeImage(
  repoRoot: string,
  onProgress?: (message: string) => void,
): { ok: boolean; image: string; message?: string } {
  const imageTag = resolveProjectImageTag(repoRoot);

  const inspectResult = spawnSync('docker', ['image', 'inspect', imageTag], { encoding: 'utf8' });
  if (inspectResult.status === 0) {
    return { ok: true, image: imageTag };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'afk-docker-'));
  onProgress?.(`Building runtime image ${imageTag}…`);

  try {
    let dockerfilePath: string;

    if (detectLaravel(repoRoot)) {
      const phpVersion = extractPhpVersion(repoRoot) || '8.3';
      onProgress?.(`Detected Laravel project (PHP ${phpVersion}), generating Laravel Dockerfile…`);
      dockerfilePath = generateLaravelDockerfile(tempDir, phpVersion);
    } else {
      onProgress?.(`Generating default Dockerfile…`);
      dockerfilePath = generateDefaultDockerfile(tempDir);
    }

    const buildResult = buildImage(dockerfilePath, imageTag, '/');
    if (!buildResult.ok) {
      return { ok: false, image: imageTag, message: buildResult.message };
    }

    return { ok: true, image: imageTag };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, image: imageTag, message };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
