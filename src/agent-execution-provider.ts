import type { OpenCodePermissionDecision, OpenCodePermissionRequest, OpenCodeSessionExecutor } from './opencode.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import { detectClaudeCodeFailure, detectCodexFailure, formatProviderFailureMessage } from './provider-failure.js';

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

const PULL_REQUEST_ALLOWED_COMMAND_KINDS: readonly AgentCommandKind[] = [
  'read',
  'diagnostic',
  'git-push',
  'github-pr',
];

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
      const sessionLabel = formatInvocationSessionLabel(invocationMode);
      request.onProgress?.({
        ticketLabel: ticket.label,
        message: `starting ${providerName} ${sessionLabel}`,
      });
      const result = await this.executor.run({
        model,
        prompt: request.prompt,
        title: formatInvocationSessionTitle(invocationMode, ticket.label),
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
            otherWorktreePaths: [
              ...Object.values(request.plan.checkouts ?? {}),
              ...Object.values(request.plan.ticketCheckouts ?? {}),
            ]
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
          ? `${providerName} ${sessionLabel} failed: ${outputFailure}`
          : `${providerName} ${sessionLabel} completed`,
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

function formatInvocationSessionLabel(mode: AgentInvocationMode): string {
  if (mode === 'reviewer') return 'reviewer session';
  if (mode === 'pull-request') return 'pull-request session';
  return 'session';
}

function formatInvocationSessionTitle(mode: AgentInvocationMode, ticketLabel: string): string {
  if (mode === 'reviewer') return `afk review: ${ticketLabel}`;
  if (mode === 'pull-request') return `afk pr: ${ticketLabel}`;
  return `afk: ${ticketLabel}`;
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

export class ClaudeAgentExecutionProvider implements AgentExecutionProvider {
  private readonly base: BaseSDKAgentExecutionProvider;

  constructor(executor: OpenCodeSessionExecutor, permissionCoordinator?: PermissionCoordinator) {
    this.base = new BaseSDKAgentExecutionProvider(
      executor,
      {
        providerName: 'claude',
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
