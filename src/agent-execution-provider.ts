import type { OpenCodePermissionDecision, OpenCodePermissionRequest, OpenCodeSessionExecutor } from './opencode.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import { detectClaudeCodeFailure, detectCodexFailure, formatProviderFailureMessage } from './provider-failure.js';

import type { AgentExecutionProgressCallback, AgentExecutionResult, LaunchPlan } from './types.js';

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
  constructor(
    private readonly result:
      | AgentExecutionResult
      | ((request: AgentExecutionRequest) => AgentExecutionResult | Promise<AgentExecutionResult>),
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return typeof this.result === 'function' ? this.result(request) : this.result;
  }
}

export interface BaseSDKAgentExecutionProviderConfig {
  providerName: string;
  agentName?: string;
  failureDetector: (output: string[]) => string | null;
  sessionIdUnavailableReason: string;
  successfulSessionRemovable?: boolean;
}

export class BaseSDKAgentExecutionProvider implements AgentExecutionProvider {
  constructor(
    private readonly executor: OpenCodeSessionExecutor,
    private readonly config: BaseSDKAgentExecutionProviderConfig,
    private readonly permissionCoordinator?: PermissionCoordinator,
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (request.signal?.aborted) {
      throw new Error('run killed');
    }
    const ticket = request.plan.tickets[request.ticketIndex];
    if (!ticket)
      return { status: 'failed', sessionId: null, removable: false, unsafeReason: 'ticket missing in launch request' };
    try {
      const invocationMode = request.invocationMode ?? 'execution';
      const model =
        invocationMode === 'reviewer' && request.plan.reviewerModel ? request.plan.reviewerModel : request.plan.model;
      const providerName = this.config.providerName;
      request.onProgress?.({
        ticketLabel: ticket.label,
        message:
          invocationMode === 'reviewer'
            ? `starting ${providerName} reviewer session`
            : `starting ${providerName} session`,
      });
      const result = await this.executor.run({
        model,
        prompt: request.prompt,
        title: invocationMode === 'reviewer' ? `afk review: ${ticket.label}` : `afk: ${ticket.label}`,
        agent: invocationMode === 'reviewer' ? undefined : this.config.agentName,
        sessionId: invocationMode === 'execution' ? request.sessionId : null,
        workDir: request.plan.checkout?.worktreePath,
        repoRoot: request.plan.repoRoot,
        onProgress: (event) => request.onProgress?.({ ticketLabel: ticket.label, ...event }),
        decidePermission: (permissionRequest) =>
          decideAfkPermission(permissionRequest, {
            ticketLabel: ticket.label,
            coordinator: this.permissionCoordinator,
            repoRoot: request.plan.repoRoot,
            worktreePath: request.plan.checkout?.worktreePath,
            otherWorktreePaths: Object.values(request.plan.checkouts ?? {})
              .map((checkout) => checkout.worktreePath)
              .filter((worktreePath) => worktreePath !== request.plan.checkout?.worktreePath),
          }),
        signal: request.signal,
      });
      const outputFailure = result.terminalError ?? this.config.failureDetector(result.output ?? []);
      if (outputFailure) {
        request.onProgress?.({
          ticketLabel: ticket.label,
          kind: 'failure',
          message: formatProviderFailureMessage({
            modelId: model?.id ?? 'unknown',
            mode: invocationMode,
            reason: outputFailure,
          }),
          sessionId: result.sessionId ?? null,
        });
      }
      request.onProgress?.({
        ticketLabel: ticket.label,
        message: outputFailure
          ? invocationMode === 'reviewer'
            ? `${providerName} reviewer session failed: ${outputFailure}`
            : `${providerName} session failed: ${outputFailure}`
          : invocationMode === 'reviewer'
            ? `${providerName} reviewer session completed`
            : `${providerName} session completed`,
        sessionId: result.sessionId ?? null,
      });
      return {
        status: outputFailure ? 'failed' : 'completed',
        sessionId: result.sessionId ?? null,
        removable: outputFailure ? false : (this.config.successfulSessionRemovable ?? true),
        output: result.output,
        unsafeReason: outputFailure ?? (result.sessionId ? null : this.config.sessionIdUnavailableReason),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : `${this.config.providerName} execution failed`;
      const invocationMode = request.invocationMode ?? 'execution';
      const model =
        invocationMode === 'reviewer' && request.plan.reviewerModel ? request.plan.reviewerModel : request.plan.model;
      request.onProgress?.({
        ticketLabel: ticket.label,
        kind: 'failure',
        message: formatProviderFailureMessage({ modelId: model?.id ?? 'unknown', mode: invocationMode, reason }),
      });
      request.onProgress?.({
        ticketLabel: ticket.label,
        message: `${this.config.providerName} execution failed: ${reason}`,
      });
      return {
        status: 'failed',
        sessionId: null,
        removable: false,
        unsafeReason: reason,
        output: [`${this.config.providerName} execution failed`],
      };
    }
  }
}

export class OpenCodeAgentExecutionProvider implements AgentExecutionProvider {
  private readonly base: BaseSDKAgentExecutionProvider;

  constructor(executor: OpenCodeSessionExecutor, permissionCoordinator?: PermissionCoordinator) {
    this.base = new BaseSDKAgentExecutionProvider(
      executor,
      {
        providerName: 'opencode',
        agentName: 'build',
        failureDetector: detectOpenCodeFailure,
        sessionIdUnavailableReason: 'session id unavailable from opencode',
      },
      permissionCoordinator,
    );
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.base.execute(request);
  }
}

export class ClaudeKimiAgentExecutionProvider implements AgentExecutionProvider {
  private readonly base: BaseSDKAgentExecutionProvider;

  constructor(executor: OpenCodeSessionExecutor, permissionCoordinator?: PermissionCoordinator) {
    this.base = new BaseSDKAgentExecutionProvider(
      executor,
      {
        providerName: 'claude-kimi',
        failureDetector: detectClaudeCodeFailure,
        sessionIdUnavailableReason: 'session id unavailable from claude',
      },
      permissionCoordinator,
    );
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.base.execute(request);
  }
}

export class CodexAgentExecutionProvider implements AgentExecutionProvider {
  private readonly base: BaseSDKAgentExecutionProvider;

  constructor(executor: OpenCodeSessionExecutor, permissionCoordinator?: PermissionCoordinator) {
    this.base = new BaseSDKAgentExecutionProvider(
      executor,
      {
        providerName: 'codex',
        failureDetector: detectCodexFailure,
        sessionIdUnavailableReason: 'thread id unavailable from codex',
        successfulSessionRemovable: false,
      },
      permissionCoordinator,
    );
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.base.execute(request);
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
  _request: OpenCodePermissionRequest,
  _options: {
    ticketLabel?: string;
    coordinator?: PermissionCoordinator;
    repoRoot?: string;
    worktreePath?: string;
    otherWorktreePaths?: string[];
  } = {},
): Promise<OpenCodePermissionDecision | null> {
  return 'always';
}

export function detectOpenCodeFailure(output: string[]): string | null {
  const failure = output.find((line) => {
    const normalized = line.toLowerCase();
    if (normalized === 'opencode error: aborted') return false;
    return (
      normalized.includes('opencode error:') ||
      normalized.includes('requested model is not available') ||
      normalized.includes('providerautherror') ||
      normalized.includes('context overflow')
    );
  });
  return failure ?? null;
}
