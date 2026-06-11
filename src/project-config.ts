import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const AFK_CONFIG_FILE = 'afk.json';

export type AfkTrackerProviderConfig = ScratchTrackerProviderConfig | LinearGraphqlTrackerProviderConfig;

export interface ScratchTrackerProviderConfig {
  kind: 'scratch';
}

export interface LinearGraphqlTrackerProviderConfig {
  kind: 'linear-graphql';
  team: LinearGraphqlTeamConfig;
  afkLabelName: string;
  workflowStates: LinearGraphqlWorkflowStatesConfig;
}

export type LinearGraphqlTeamConfig = { key: string; id?: string } | { key?: string; id: string };

export interface LinearGraphqlWorkflowStatesConfig {
  ready: LinearGraphqlWorkflowStateConfig;
  running: LinearGraphqlWorkflowStateConfig;
  done: LinearGraphqlWorkflowStateConfig;
  handoff: LinearGraphqlWorkflowStateConfig;
}

export type LinearGraphqlWorkflowStateConfig = { name: string; id?: string } | { name?: string; id: string };

export interface AfkProjectConfig {
  testsEnabled: boolean;
  testEnvFile?: string;
  smokeTestCommand?: string;
  staticCheckCommands: string[];
  provider: AfkTrackerProviderConfig;
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

  const providerValidation = validateProviderConfig(record.provider);
  errors.push(...providerValidation.errors);

  if (errors.length || typeof record.testsEnabled !== 'boolean' || !providerValidation.config) return { errors };

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
      provider: providerValidation.config,
    },
    errors: [],
  };
}

function validateProviderConfig(value: unknown): { config?: AfkTrackerProviderConfig; errors: string[] } {
  if (value === undefined) return { config: { kind: 'scratch' }, errors: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: ['provider must be an object when present.'] };
  }

  const record = value as Record<string, unknown>;
  const credentialErrors = credentialFields(record, 'provider');
  if (record.kind !== 'scratch' && record.kind !== 'linear-graphql') {
    return {
      errors: [`provider.kind must be one of: scratch, linear-graphql.`, ...credentialErrors],
    };
  }

  if (record.kind === 'scratch') {
    return credentialErrors.length ? { errors: credentialErrors } : { config: { kind: 'scratch' }, errors: [] };
  }

  const errors = [...credentialErrors];
  const team = validateTeamConfig(record.team);
  const workflowStates = validateWorkflowStates(record.workflowStates);
  const afkLabelName = record.afkLabelName;

  errors.push(...team.errors, ...workflowStates.errors);
  if (typeof afkLabelName !== 'string' || !afkLabelName.trim()) {
    errors.push('provider.afkLabelName must be a non-empty string.');
  }

  if (errors.length || !team.config || !workflowStates.config || typeof afkLabelName !== 'string') return { errors };

  return {
    config: {
      kind: 'linear-graphql',
      team: team.config,
      afkLabelName: afkLabelName.trim(),
      workflowStates: workflowStates.config,
    },
    errors: [],
  };
}

function validateWorkflowStates(value: unknown): { config?: LinearGraphqlWorkflowStatesConfig; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: ['provider.workflowStates must be an object.'] };
  }

  const record = value as Record<string, unknown>;
  const ready = validateWorkflowStateConfig(record.ready, 'provider.workflowStates.ready');
  const running = validateWorkflowStateConfig(record.running, 'provider.workflowStates.running');
  const done = validateWorkflowStateConfig(record.done, 'provider.workflowStates.done');
  const handoff = validateWorkflowStateConfig(record.handoff, 'provider.workflowStates.handoff');
  const errors = [
    ...credentialFields(record, 'provider.workflowStates'),
    ...ready.errors,
    ...running.errors,
    ...done.errors,
    ...handoff.errors,
  ];

  if (errors.length || !ready.config || !running.config || !done.config || !handoff.config) return { errors };

  return {
    config: {
      ready: ready.config,
      running: running.config,
      done: done.config,
      handoff: handoff.config,
    },
    errors: [],
  };
}

function validateTeamConfig(value: unknown): { config?: LinearGraphqlTeamConfig; errors: string[] } {
  const result = validateKeyOrId(value, 'provider.team');
  return { config: result.config as LinearGraphqlTeamConfig | undefined, errors: result.errors };
}

function validateWorkflowStateConfig(
  value: unknown,
  field: string,
): { config?: LinearGraphqlWorkflowStateConfig; errors: string[] } {
  const result = validateKeyOrId(value, field, 'name');
  return { config: result.config as LinearGraphqlWorkflowStateConfig | undefined, errors: result.errors };
}

function validateKeyOrId(
  value: unknown,
  field: string,
  primaryKey: 'key' | 'name' = 'key',
): {
  config?:
    | { key: string; id?: string }
    | { name: string; id?: string }
    | { key?: string; id: string }
    | { name?: string; id: string };
  errors: string[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: [`${field} must be an object with ${primaryKey} or id.`] };
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  const primary = record[primaryKey];
  const errors = credentialFields(record, field);
  if (primary !== undefined && (typeof primary !== 'string' || !primary.trim())) {
    errors.push(`${field}.${primaryKey} must be a non-empty string when present.`);
  }
  if (id !== undefined && (typeof id !== 'string' || !id.trim())) {
    errors.push(`${field}.id must be a non-empty string when present.`);
  }
  if ((typeof primary !== 'string' || !primary.trim()) && (typeof id !== 'string' || !id.trim())) {
    errors.push(`${field} must include ${primaryKey} or id.`);
  }
  if (errors.length) return { errors };

  return {
    config: {
      ...(typeof primary === 'string' && primary.trim() ? { [primaryKey]: primary.trim() } : {}),
      ...(typeof id === 'string' && id.trim() ? { id: id.trim() } : {}),
    } as
      | { key: string; id?: string }
      | { name: string; id?: string }
      | { key?: string; id: string }
      | { name?: string; id: string },
    errors: [],
  };
}

function credentialFields(record: Record<string, unknown>, field: string, seen = new WeakSet<object>()): string[] {
  if (seen.has(record)) return [];
  seen.add(record);

  return Object.entries(record).flatMap(([key, value]) => {
    const nestedField = `${field}.${key}`;
    const errors = /token|secret|password|credential|apiKey/i.test(key)
      ? [`${nestedField} must not be stored in ${AFK_CONFIG_FILE}; use environment variables or an auth store.`]
      : [];

    if (value && typeof value === 'object') {
      errors.push(...credentialFields(value as Record<string, unknown>, nestedField, seen));
    }

    return errors;
  });
}

function unknownPlaceholders(command: string): string[] {
  const placeholders = command.match(/\{[^}]+\}/g) ?? [];
  return [...new Set(placeholders.filter((placeholder) => placeholder !== '{testFile}'))];
}
