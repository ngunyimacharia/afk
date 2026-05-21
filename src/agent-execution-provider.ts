import type { OpenCodePermissionDecision, OpenCodePermissionRequest, OpenCodeSessionExecutor } from './opencode.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import { formatProviderFailureMessage } from './provider-failure.js';
import { areAllPathsAllowedForAfkWrite, areAllPathsInAssignedWorktree } from './repo-boundary.js';
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

export class OpenCodeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(
    private readonly executor: OpenCodeSessionExecutor,
    private readonly permissionCoordinator?: PermissionCoordinator,
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const ticket = request.plan.tickets[request.ticketIndex];
    if (!ticket)
      return { status: 'failed', sessionId: null, removable: false, unsafeReason: 'ticket missing in launch request' };
    try {
      const invocationMode = request.invocationMode ?? 'execution';
      const model =
        invocationMode === 'reviewer' && request.plan.reviewerModel ? request.plan.reviewerModel : request.plan.model;
      request.onProgress?.({
        ticketLabel: ticket.label,
        message: invocationMode === 'reviewer' ? 'starting opencode reviewer session' : 'starting opencode session',
      });
      const result = await this.executor.run({
        model,
        prompt: request.prompt,
        title: invocationMode === 'reviewer' ? `afk review: ${ticket.label}` : `afk: ${ticket.label}`,
        agent: invocationMode === 'reviewer' ? undefined : 'build',
        sessionId: invocationMode === 'execution' ? request.sessionId : null,
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
      });
      const finalResult = invocationMode === 'execution' ? parseAfkTicketResult(result.finalMessageText) : null;
      const failureReason = finalResult
        ? formatAfkTicketFailure(finalResult)
        : (result.terminalError ?? detectOpenCodeFailure(result.output ?? []));
      if (failureReason) {
        request.onProgress?.({
          ticketLabel: ticket.label,
          kind: 'failure',
          message: formatProviderFailureMessage({
            modelId: model?.id ?? 'unknown',
            mode: invocationMode,
            reason: failureReason,
          }),
          sessionId: result.sessionId ?? null,
        });
      }
      request.onProgress?.({
        ticketLabel: ticket.label,
        message: failureReason
          ? invocationMode === 'reviewer'
            ? `opencode reviewer session failed: ${failureReason}`
            : `opencode session failed: ${failureReason}`
          : invocationMode === 'reviewer'
            ? 'opencode reviewer session completed'
            : 'opencode session completed',
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
      const model =
        invocationMode === 'reviewer' && request.plan.reviewerModel ? request.plan.reviewerModel : request.plan.model;
      request.onProgress?.({
        ticketLabel: ticket.label,
        kind: 'failure',
        message: formatProviderFailureMessage({ modelId: model?.id ?? 'unknown', mode: invocationMode, reason }),
      });
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

export async function decideAfkPermission(
  request: OpenCodePermissionRequest,
  options: {
    ticketLabel?: string;
    coordinator?: PermissionCoordinator;
    repoRoot?: string;
    worktreePath?: string;
    otherWorktreePaths?: string[];
  } = {},
): Promise<OpenCodePermissionDecision | null> {
  if (isReadLikePermission(request)) {
    if (
      options.repoRoot &&
      options.worktreePath &&
      areAllPathsInAssignedWorktree({
        repoRoot: options.repoRoot,
        worktreePath: options.worktreePath,
        targets: request.patterns,
      })
    )
      return 'always';
  }

  if (request.type === 'external_directory' || isWriteLikePermission(request)) {
    if (
      options.repoRoot &&
      options.worktreePath &&
      areAllPathsAllowedForAfkWrite({
        repoRoot: options.repoRoot,
        worktreePath: options.worktreePath,
        otherWorktreePaths: options.otherWorktreePaths ?? [],
        targets: request.patterns,
      })
    )
      return 'always';
    return 'reject';
  }
  if (options.coordinator) return options.coordinator.submitForTicket(options.ticketLabel ?? 'unknown-ticket', request);
  return null;
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

export type AfkTicketResult =
  | { status: 'success' }
  | { status: 'failed'; reason?: string }
  | { status: 'unknown'; reason: string };

export function parseAfkTicketResult(finalMessageText: string | null | undefined): AfkTicketResult | null {
  if (typeof finalMessageText !== 'string') return null;

  const lines = finalMessageText.split(/\r?\n/).map((line) => line.trim());
  const hasSuccess = lines.includes('AFK_TICKET_RESULT: success');
  const hasFailed = lines.includes('AFK_TICKET_RESULT: failed');
  if (hasSuccess && hasFailed) return { status: 'unknown', reason: 'final AFK result sentinel is ambiguous' };
  if (hasSuccess) return { status: 'success' };
  if (hasFailed) return { status: 'failed', reason: extractAfkFailureReason(lines) };
  return { status: 'unknown', reason: 'final AFK result sentinel missing' };
}

function formatAfkTicketFailure(result: AfkTicketResult): string | null {
  if (result.status === 'success') return null;
  if (result.status === 'failed') return result.reason ? `AFK ticket failed: ${result.reason}` : 'AFK ticket failed';
  return result.reason;
}

function extractAfkFailureReason(lines: string[]): string | undefined {
  const reason = lines
    .find((line) => line.startsWith('Reason:'))
    ?.replace(/^Reason:\s*/, '')
    .trim();
  return reason || undefined;
}

function isReadLikePermission(request: OpenCodePermissionRequest): boolean {
  const value = `${request.type} ${request.title}`.toLowerCase();
  return /\bread\b/.test(value) && request.patterns.length > 0;
}

function isWriteLikePermission(request: OpenCodePermissionRequest): boolean {
  const value = `${request.type} ${request.title}`.toLowerCase();
  return /\b(write|edit|delete|patch|apply|modify|create|remove)\b/.test(value) && request.patterns.length > 0;
}
