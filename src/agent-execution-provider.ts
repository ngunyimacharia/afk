import type { AgentExecutionResult, LaunchPlan } from './types.js';

export type AgentInvocationMode = 'execution' | 'reviewer';

export type AgentCommandKind =
  | 'read'
  | 'diagnostic'
  | 'write'
  | 'edit'
  | 'delete'
  | 'git-commit'
  | 'git-push'
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
  'scratch-write',
];

const REVIEWER_ALLOWED_COMMAND_KINDS: readonly AgentCommandKind[] = ['read', 'diagnostic'];

export interface AgentExecutionRequest {
  plan: LaunchPlan;
  ticketIndex: number;
  prompt: string;
  invocationMode?: AgentInvocationMode;
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
      canMutateGitState: false,
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
  if (policy.mode !== 'reviewer') return true;

  return command.kind === 'read' || command.kind === 'diagnostic';
}

export function assertCommandAllowed(policy: AgentInvocationPolicy, command: AgentCommandRequest): void {
  if (isCommandAllowed(policy, command)) return;

  if (policy.mode === 'reviewer') {
    const target = command.target ? `: ${command.target}` : '';
    throw new Error(`Reviewer mode blocks ${command.kind} commands${target}`);
  }

  throw new Error(`Command not allowed: ${command.kind}`);
}

export class FakeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(private readonly result: AgentExecutionResult) {}

  async execute(_request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.result;
  }
}
