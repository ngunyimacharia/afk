import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const AFK_CONFIG_FILE = 'afk.json';

export interface AfkProjectConfig {
  testsEnabled: boolean;
  testEnvFile?: string;
  smokeTestCommand?: string;
  staticCheckCommands: string[];
  linear?: LinearProjectConfig;
}

export interface LinearProjectConfig {
  team?: string;
  afkLabel?: string;
  teamId?: string;
  teamKey?: string;
  labelName?: string;
  workflowStates: {
    ready: string;
    running: string;
    done: string;
    handoff: string;
  };
  apiKeyEnv?: string;
  afkLabelName: string;
  readyStateName: string;
  applyAfkLabelToParents?: boolean;
}

export interface AfkLinearWorkflowStatesConfig {
  ready: string;
  running: string;
  done: string;
  handoff: string;
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

  const linear = validateLinearProjectConfig(record.linear, errors);

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
      ...(linear ? { linear } : {}),
    },
    errors: [],
  };
}

function validateLinearProjectConfig(value: unknown, errors: string[]): LinearProjectConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('linear must be an object when present.');
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (hasLinearSecretField(record)) {
    errors.push(
      'linear config must not include API keys or tokens; set linear.apiKeyEnv and export that environment variable.',
    );
  }
  if (!isNonEmptyString(record.team) && !isNonEmptyString(record.teamId) && !isNonEmptyString(record.teamKey)) {
    errors.push(
      'Linear setup incomplete: configure linear.team, linear.teamId, or linear.teamKey after confirming the Linear team exists.',
    );
  }
  if (!isNonEmptyString(record.afkLabel) && !isNonEmptyString(record.labelName)) {
    errors.push('Linear setup incomplete: configure linear.labelName for an existing dedicated AFK label.');
  }
  const workflowStates = validateLinearWorkflowStatesConfig(record.workflowStates, errors);
  if (record.team !== undefined && !isNonEmptyString(record.team)) {
    errors.push('linear.team must be a non-empty string when present.');
  }
  if (record.afkLabel !== undefined && !isNonEmptyString(record.afkLabel)) {
    errors.push('linear.afkLabel must be a non-empty string when present.');
  }
  if (record.teamId !== undefined && !isNonEmptyString(record.teamId)) {
    errors.push('linear.teamId must be a non-empty string when present.');
  }
  if (record.teamKey !== undefined && !isNonEmptyString(record.teamKey)) {
    errors.push('linear.teamKey must be a non-empty string when present.');
  }
  if (record.apiKeyEnv !== undefined && (typeof record.apiKeyEnv !== 'string' || !record.apiKeyEnv.trim())) {
    errors.push('linear.apiKeyEnv must be a non-empty string when present.');
  }
  const team = firstTrimmedString(record.team, record.teamId, record.teamKey);
  const labelName = firstTrimmedString(record.labelName, record.afkLabel);
  if (!team || !labelName) {
    return undefined;
  }
  if (!workflowStates) return undefined;
  if (record.afkLabelName !== undefined && !isNonEmptyString(record.afkLabelName)) {
    errors.push('linear.afkLabelName must be a non-empty string when present.');
  }
  if (record.readyStateName !== undefined && !isNonEmptyString(record.readyStateName)) {
    errors.push('linear.readyStateName must be a non-empty string when present.');
  }
  if (record.applyAfkLabelToParents !== undefined && typeof record.applyAfkLabelToParents !== 'boolean') {
    errors.push('linear.applyAfkLabelToParents must be a boolean when present.');
  }
  if (record.afkLabelName !== undefined && !isNonEmptyString(record.afkLabelName)) return undefined;
  if (record.readyStateName !== undefined && !isNonEmptyString(record.readyStateName)) return undefined;

  return {
    team,
    afkLabel: firstTrimmedString(record.afkLabel, record.labelName) as string,
    ...(isNonEmptyString(record.teamId) ? { teamId: record.teamId.trim() } : {}),
    ...(isNonEmptyString(record.teamKey) ? { teamKey: record.teamKey.trim() } : {}),
    labelName,
    workflowStates,
    ...(typeof record.apiKeyEnv === 'string' && record.apiKeyEnv.trim() ? { apiKeyEnv: record.apiKeyEnv.trim() } : {}),
    afkLabelName: firstTrimmedString(record.afkLabelName, record.labelName, record.afkLabel) as string,
    readyStateName: firstTrimmedString(record.readyStateName, workflowStates.ready) as string,
    ...(typeof record.applyAfkLabelToParents === 'boolean'
      ? { applyAfkLabelToParents: record.applyAfkLabelToParents }
      : {}),
  };
}

function validateLinearWorkflowStatesConfig(
  value: unknown,
  errors: string[],
): AfkLinearWorkflowStatesConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(
      'Linear setup incomplete: configure linear.workflowStates with existing ready, running, done, and handoff state names or IDs.',
    );
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const states = ['ready', 'running', 'done', 'handoff'] as const;
  for (const state of states) {
    if (!isNonEmptyString(record[state])) {
      errors.push(
        `Linear setup incomplete: configure linear.workflowStates.${state} for an existing Linear workflow state.`,
      );
    }
  }
  if (states.some((state) => !isNonEmptyString(record[state]))) return undefined;

  const ready = record.ready as string;
  const running = record.running as string;
  const done = record.done as string;
  const handoff = record.handoff as string;

  return {
    ready: ready.trim(),
    running: running.trim(),
    done: done.trim(),
    handoff: handoff.trim(),
  };
}

function hasLinearSecretField(record: Record<string, unknown>): boolean {
  return ['apiKey', 'token', 'accessToken'].some((field) => record[field] !== undefined);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return undefined;
}

function unknownPlaceholders(command: string): string[] {
  const placeholders = command.match(/\{[^}]+\}/g) ?? [];
  return [...new Set(placeholders.filter((placeholder) => placeholder !== '{testFile}'))];
}
