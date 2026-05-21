import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const AFK_CONFIG_FILE = 'afk.json';

export interface AfkProjectConfig {
  testsEnabled: boolean;
  testEnvFile?: string;
  smokeTestCommand?: string;
  staticCheckCommands: string[];
}

export interface ProjectConfigLoadResult {
  config?: AfkProjectConfig;
  path: string;
  errors: string[];
}

export function afkConfigPath(repoRoot: string): string {
  return path.join(repoRoot, AFK_CONFIG_FILE);
}

export function loadAfkProjectConfig(repoRoot: string): ProjectConfigLoadResult {
  const configPath = afkConfigPath(repoRoot);
  if (!existsSync(configPath))
    return { path: configPath, errors: ['Project config missing. Run `/afk-config` in OpenCode first.'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    return { path: configPath, errors: [`Invalid ${AFK_CONFIG_FILE}: ${reason}`] };
  }

  const validation = validateAfkProjectConfig(parsed);
  return validation.config
    ? { path: configPath, config: validation.config, errors: [] }
    : { path: configPath, errors: validation.errors };
}

export function saveAfkProjectConfig(repoRoot: string, config: AfkProjectConfig): void {
  writeFileSync(afkConfigPath(repoRoot), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function validateAfkProjectConfig(value: unknown): { config?: AfkProjectConfig; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: [`${AFK_CONFIG_FILE} must contain a JSON object.`] };
  }

  const record = value as Record<string, unknown>;
  if (typeof record.testsEnabled !== 'boolean') errors.push('testsEnabled must be a boolean.');

  const testEnvFile = record.testEnvFile;
  if (testEnvFile !== undefined && (typeof testEnvFile !== 'string' || !testEnvFile.trim())) {
    errors.push('testEnvFile must be a non-empty string when present.');
  }

  const smokeTestCommand = record.smokeTestCommand;
  if (record.testsEnabled === true && (typeof smokeTestCommand !== 'string' || !smokeTestCommand.trim())) {
    errors.push('smokeTestCommand is required when testsEnabled is true.');
  }
  if (typeof smokeTestCommand === 'string') {
    const unknown = unknownPlaceholders(smokeTestCommand);
    if (unknown.length) errors.push(`smokeTestCommand contains unknown placeholder(s): ${unknown.join(', ')}.`);
  } else if (smokeTestCommand !== undefined) {
    errors.push('smokeTestCommand must be a string when present.');
  }

  const staticCheckCommands = record.staticCheckCommands ?? [];
  if (
    !Array.isArray(staticCheckCommands) ||
    staticCheckCommands.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    errors.push('staticCheckCommands must be an array of non-empty strings when present.');
  }

  if (errors.length || typeof record.testsEnabled !== 'boolean') return { errors };

  return {
    config: {
      testsEnabled: record.testsEnabled,
      ...(typeof testEnvFile === 'string' && testEnvFile.trim() ? { testEnvFile: testEnvFile.trim() } : {}),
      ...(typeof smokeTestCommand === 'string' && smokeTestCommand.trim()
        ? { smokeTestCommand: smokeTestCommand.trim() }
        : {}),
      staticCheckCommands: Array.isArray(staticCheckCommands)
        ? staticCheckCommands.map((item) => String(item).trim())
        : [],
    },
    errors: [],
  };
}

function unknownPlaceholders(command: string): string[] {
  const placeholders = command.match(/\{[^}]+\}/g) ?? [];
  return [...new Set(placeholders.filter((placeholder) => placeholder !== '{testFile}'))];
}
