import type { AgentExecutionProgressCallback, AgentExecutionResult, LaunchPlan } from './types.js';
import type { OpenCodePermissionDecision, OpenCodePermissionRequest, OpenCodeSessionExecutor } from './opencode.js';
import { classifyProviderFailure, formatProviderFailureMessage } from './provider-failure.js';

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
  onProgress?: AgentExecutionProgressCallback;
  invocationMode?: AgentInvocationMode;
  sessionId?: string | null;
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
  constructor(private readonly result: AgentExecutionResult | ((request: AgentExecutionRequest) => AgentExecutionResult | Promise<AgentExecutionResult>)) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return typeof this.result === 'function' ? this.result(request) : this.result;
  }
}

export class OpenCodeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(private readonly executor: OpenCodeSessionExecutor) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const ticket = request.plan.tickets[request.ticketIndex];
    if (!ticket) return { status: 'failed', sessionId: null, removable: false, unsafeReason: 'ticket missing in launch request' };
    try {
      const invocationMode = request.invocationMode ?? 'execution';
      const model = invocationMode === 'reviewer' && request.plan.reviewerModel ? request.plan.reviewerModel : request.plan.model;
      request.onProgress?.({ ticketLabel: ticket.label, message: invocationMode === 'reviewer' ? 'starting opencode reviewer session' : 'starting opencode session' });
      const result = await this.executor.run({
        model,
        prompt: request.prompt,
        title: invocationMode === 'reviewer' ? `afk review: ${ticket.label}` : `afk: ${ticket.label}`,
        agent: invocationMode === 'reviewer' ? 'review' : 'build',
        onProgress: (event) => request.onProgress?.({ ticketLabel: ticket.label, ...event }),
        decidePermission: decideAfkPermission,
      });
      const failureReason = detectOpenCodeFailure(result.output ?? []);
      if (failureReason) {
        request.onProgress?.({
          ticketLabel: ticket.label,
          kind: 'failure',
          message: formatProviderFailureMessage({ modelId: model?.id ?? 'unknown', mode: invocationMode, reason: failureReason }),
          sessionId: result.sessionId ?? null,
        });
      }
      request.onProgress?.({
        ticketLabel: ticket.label,
        message: failureReason
          ? invocationMode === 'reviewer' ? `opencode reviewer session failed: ${failureReason}` : `opencode session failed: ${failureReason}`
          : invocationMode === 'reviewer' ? 'opencode reviewer session completed' : 'opencode session completed',
        sessionId: result.sessionId ?? null,
      });
      return {
        status: failureReason ? 'failed' : 'completed',
        sessionId: result.sessionId ?? null,
        removable: !failureReason,
        output: result.output,
        unsafeReason: failureReason ?? (result.sessionId ? null : 'session id unavailable from opencode'),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'opencode execution failed';
      const invocationMode = request.invocationMode ?? 'execution';
      const model = invocationMode === 'reviewer' && request.plan.reviewerModel ? request.plan.reviewerModel : request.plan.model;
      request.onProgress?.({ ticketLabel: ticket.label, kind: 'failure', message: formatProviderFailureMessage({ modelId: model?.id ?? 'unknown', mode: invocationMode, reason }) });
      request.onProgress?.({ ticketLabel: ticket.label, message: `opencode execution failed: ${reason}` });
      return {
        status: 'failed',
        sessionId: null,
        removable: false,
        unsafeReason: reason,
        output: ['opencode execution failed'],
      };
    }
  }
}

export async function decideAfkPermission(request: OpenCodePermissionRequest): Promise<OpenCodePermissionDecision | null> {
  if (request.type === 'external_directory') return 'reject';
  return null;
}

export function detectOpenCodeFailure(output: string[]): string | null {
  const failure = output.find((line) => {
    const normalized = line.toLowerCase();
    return normalized.includes('opencode error:')
      || normalized.includes('requested model is not available')
      || normalized.includes('providerautherror')
      || normalized.includes('context overflow')
      || normalized.includes('tool failed:');
  });
  return failure ?? null;
}
