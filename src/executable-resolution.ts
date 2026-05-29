import { execFileSync } from 'node:child_process';

export class RequiredExecutableError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Required executable not found: ${missing.join(', ')}`);
    this.name = 'RequiredExecutableError';
  }
}

export function resolveExecutable(name: string): string {
  try {
    const resolved = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    return resolved;
  } catch {
    throw new RequiredExecutableError([name]);
  }
}

export function resolveExecutables(names: string[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of names) {
    try {
      resolved[name] = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    } catch {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new RequiredExecutableError(missing);
  }

  return resolved;
}

export function logResolvedExecutables(
  resolved: Record<string, string>,
  log: (message: string) => void = console.log,
): void {
  for (const [name, path] of Object.entries(resolved)) {
    log(`Resolved executable: ${name} -> ${path}`);
  }
}
