import type { OpenCodePermissionDecision, OpenCodePermissionRequest } from './opencode.js';
import type { PermissionCoordinator } from './permission-coordinator.js';

import type { AgentExecutionProgressCallback, AgentExecutionResult, LaunchPlan } from './types.js';

export type AgentInvocationMode = 'execution' | 'reviewer' | 'pull-request';

export type AgentCommandKind =
  | 'read'
  | 'diagnostic'
  | 'write'
  | 'edit'
  | 'delete'
  | 'git-commit'
  | 'git-push'
  | 'github-pr'
  | 'scratch-write';

export interface AgentCommandRequest {
  kind: AgentCommandKind;
  target?: string;
  summary?: string;
}

export interface AgentInvocationPolicy {
  mode: AgentInvocationMode;
  allowedCommandKinds: readonly AgentCommandKind[];
  canMutateWorkspace: boolean;
  canMutateGitState: boolean;
  canMutateScratch: boolean;
}

const EXECUTION_ALLOWED_COMMAND_KINDS: readonly AgentCommandKind[] = [
  'read',
  'diagnostic',
  'write',
  'edit',
  'delete',
  'git-commit',
  'git-push',
  'github-pr',
  'scratch-write',
];

const REVIEWER_ALLOWED_COMMAND_KINDS: readonly AgentCommandKind[] = [
  'read',
  'diagnostic',
  'scratch-write',
  'git-commit',
];

const PULL_REQUEST_ALLOWED_COMMAND_KINDS: readonly AgentCommandKind[] = ['read', 'diagnostic', 'git-push', 'github-pr'];

export interface AgentExecutionRequest {
  plan: LaunchPlan;
  ticketIndex: number;
  prompt: string;
  onProgress?: AgentExecutionProgressCallback;
  invocationMode?: AgentInvocationMode;
  sessionId?: string | null;
  signal?: AbortSignal;
}

export interface AgentExecutionProvider {
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}

export function resolveAgentInvocationPolicy(mode: AgentInvocationMode = 'execution'): AgentInvocationPolicy {
  if (mode === 'reviewer') {
    return {
      mode,
      allowedCommandKinds: REVIEWER_ALLOWED_COMMAND_KINDS,
      canMutateWorkspace: false,
      canMutateGitState: true,
      canMutateScratch: true,
    };
  }

  if (mode === 'pull-request') {
    return {
      mode,
      allowedCommandKinds: PULL_REQUEST_ALLOWED_COMMAND_KINDS,
      canMutateWorkspace: false,
      canMutateGitState: true,
      canMutateScratch: false,
    };
  }

  return {
    mode: 'execution',
    allowedCommandKinds: EXECUTION_ALLOWED_COMMAND_KINDS,
    canMutateWorkspace: true,
    canMutateGitState: true,
    canMutateScratch: true,
  };
}

export function isCommandAllowed(policy: AgentInvocationPolicy, command: AgentCommandRequest): boolean {
  if (!policy.allowedCommandKinds.includes(command.kind)) return false;
  return true;
}

export function assertCommandAllowed(policy: AgentInvocationPolicy, command: AgentCommandRequest): void {
  if (isCommandAllowed(policy, command)) return;

  if (policy.mode === 'reviewer' || policy.mode === 'pull-request') {
    const target = command.target ? `: ${command.target}` : '';
    const label = policy.mode === 'reviewer' ? 'Reviewer' : 'Pull-request';
    throw new Error(`${label} mode blocks ${command.kind} commands${target}`);
  }

  throw new Error(`Command not allowed: ${command.kind}`);
}

export class FakeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(
    private readonly result:
      | AgentExecutionResult
      | ((request: AgentExecutionRequest) => AgentExecutionResult | Promise<AgentExecutionResult>),
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return typeof this.result === 'function' ? this.result(request) : this.result;
  }
}

export class CompositeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(
    private readonly executionProvider: AgentExecutionProvider,
    private readonly reviewerProvider: AgentExecutionProvider,
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const provider = request.invocationMode === 'reviewer' ? this.reviewerProvider : this.executionProvider;
    return provider.execute(request);
  }
}

export async function decideAfkPermission(
  request: OpenCodePermissionRequest,
  options: {
    ticketLabel?: string;
    coordinator?: PermissionCoordinator;
    repoRoot?: string;
    worktreePath?: string;
    policy?: AgentInvocationPolicy;
    otherWorktreePaths?: string[];
  } = {},
): Promise<OpenCodePermissionDecision | null> {
  const policy = options.policy ?? resolveAgentInvocationPolicy('execution');
  if (!isPermissionAllowedByPolicy(request, policy)) return 'reject';
  return 'always';
}

function isPermissionAllowedByPolicy(request: OpenCodePermissionRequest, policy: AgentInvocationPolicy): boolean {
  if (policy.canMutateWorkspace && policy.canMutateScratch) return true;

  const commandKind = commandKindFromPermissionRequest(request);
  if (!commandKind && isBashPermissionRequest(request)) return false;
  if (!commandKind) return true;
  return isCommandAllowed(policy, { kind: commandKind, target: request.patterns.join(', ') || request.title });
}

function commandKindFromPermissionRequest(request: OpenCodePermissionRequest): AgentCommandKind | null {
  const value = `${request.type} ${request.title}`.toLowerCase();
  if (isBashPermissionRequest(request)) return commandKindFromBashPermission(request.title, request.patterns);
  if (value.includes('scratch')) return 'scratch-write';
  if (value.includes('delete') || value.includes('remove')) return 'delete';
  if (value.includes('edit') || value.includes('write') || value.includes('patch')) return 'edit';
  return null;
}

function isBashPermissionRequest(request: OpenCodePermissionRequest): boolean {
  const type = request.type.toLowerCase();
  const title = request.title.toLowerCase();
  return type === 'bash' || title === 'bash' || /\bbash\b/.test(title);
}

function commandKindFromBashPermission(title: string, patterns: string[]): AgentCommandKind | null {
  const command = [title, ...patterns].join('\n').toLowerCase();
  if (!command) return null;
  if (/\b(rm|unlink|rmdir)\b/.test(command)) return 'delete';
  if (/\bgit(?:\s+-c\s+\S+|\s+-C\s+\S+|\s+--git-dir(?:=|\s+)\S+|\s+--work-tree(?:=|\s+)\S+)*\s+push\b/.test(command))
    return 'git-push';
  if (/\bgh(?:\s+(?:--repo|-R)\s+\S+|\s+--repo=\S+)*\s+pr\s+create\b/.test(command)) return 'github-pr';
  if (/\b(mkdir|touch|cp|mv|install)\b[^\n]*\b\.scratch\b/.test(command)) return 'scratch-write';
  if (/\b(cat|printf|tee)\b[^\n]*(>|>>)\s*\.scratch\b/.test(command)) return 'scratch-write';
  if (/\b(mkdir|touch|cp|mv|install)\b/.test(command)) return 'edit';
  if (/\b(git\s+apply|apply_patch|patch|sed\s+-i|perl\s+-i)\b/.test(command)) return 'edit';
  if (/(^|\s)(>|>>)\s*\S+/.test(command) || /\btee\b/.test(command)) return 'edit';
  if (/\b(bun|npm|pnpm|yarn)\s+(test|run|exec)\b/.test(command)) return 'diagnostic';
  if (/\b(git\s+(diff|status|log|show)|ls|find|rg|grep)\b/.test(command)) return 'read';
  return null;
}
