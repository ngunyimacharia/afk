import type { AgentExecutionProvider, AgentExecutionRequest } from './agent-execution-provider.js';
import { decideAfkPermission, resolveAgentInvocationPolicy } from './agent-execution-provider.js';
import { ClaudeCodeSessionExecutor } from './claude-code.js';
import { CodexSessionExecutor } from './codex.js';
import { type OpenCodeSessionExecutor, type OpenCodeSessionProgressEvent, SDKOpenCodeSessionExecutor } from './opencode.js';
import type { SandcastleAgentProviderSelection } from './sandcastle-provider.js';
import type { AgentExecutionResult } from './types.js';

export interface SandcastlePhaseExecutionInput {
  request: AgentExecutionRequest;
  provider: SandcastleAgentProviderSelection | undefined;
}

export interface SandcastlePhaseExecutionClient {
  execute(input: SandcastlePhaseExecutionInput): Promise<AgentExecutionResult>;
}

class MissingSandcastleExecutionClient implements SandcastlePhaseExecutionClient {
  async execute(input: SandcastlePhaseExecutionInput): Promise<AgentExecutionResult> {
    const phase = input.request.invocationMode ?? 'execution';
    return {
      status: 'blocked',
      sessionId: null,
      removable: false,
      unsafeReason: `Sandcastle ${phase} execution client is not configured`,
      output: [`Sandcastle ${phase} execution client is not configured`],
    };
  }
}

class DefaultSandcastleExecutionClient implements SandcastlePhaseExecutionClient {
  private readonly missingClient = new MissingSandcastleExecutionClient();

  async execute(input: SandcastlePhaseExecutionInput): Promise<AgentExecutionResult> {
    if (!input.provider) return this.missingClient.execute(input);

    const request = input.request;
    const executor = this.createExecutor(input.provider, request.plan.repoRoot);
    const ticket = request.plan.tickets[request.ticketIndex];
    const model = request.invocationMode === 'reviewer' ? request.plan.reviewerModel : request.plan.model;
    if (!model) {
      return {
        status: 'blocked',
        sessionId: request.sessionId ?? null,
        removable: false,
        unsafeReason: `Sandcastle ${request.invocationMode ?? 'execution'} model is not configured`,
      };
    }

    const sessionResult = await executor.run({
      model: input.provider.model ? { ...model, id: input.provider.model } : model,
      prompt: request.prompt,
      title: ticket?.label ?? 'AFK ticket',
      agent: request.invocationMode === 'reviewer' ? 'review' : undefined,
      sessionId: request.sessionId,
      workDir: request.plan.checkout.worktreePath,
      repoRoot: request.plan.repoRoot,
      permissionMode: 'allow',
      onProgress: (event) => request.onProgress?.(toAgentProgressEvent(ticket?.label ?? 'unknown', event)),
      decidePermission: (permissionRequest) =>
        decideAfkPermission(permissionRequest, {
          ticketLabel: ticket?.label,
          repoRoot: request.plan.repoRoot,
          worktreePath: request.plan.checkout.worktreePath,
          policy: resolveAgentInvocationPolicy(request.invocationMode),
        }),
      signal: request.signal,
    });

    return {
      status: sessionResult.terminalError ? 'failed' : 'completed',
      sessionId: sessionResult.sessionId ?? null,
      removable: true,
      unsafeReason: sessionResult.terminalError ?? null,
      output: sessionResult.output,
    };
  }

  private createExecutor(provider: SandcastleAgentProviderSelection, repoRoot: string): OpenCodeSessionExecutor {
    if (provider.provider === 'claudeCode') return new ClaudeCodeSessionExecutor(repoRoot);
    if (provider.provider === 'codex') return new CodexSessionExecutor();
    return new SDKOpenCodeSessionExecutor();
  }
}

function toAgentProgressEvent(ticketLabel: string, event: OpenCodeSessionProgressEvent) {
  return {
    ticketLabel,
    message: event.message,
    sessionId: event.sessionId,
    kind: event.kind,
    toolName: event.toolName,
    toolStatus: event.toolStatus,
    permissionId: event.permissionId,
    permissionPatterns: event.permissionPatterns,
    permissionType: event.permissionType,
    permissionTitle: event.permissionTitle,
  };
}

export class SandcastleAgentExecutionProvider implements AgentExecutionProvider {
  constructor(private readonly client: SandcastlePhaseExecutionClient = new DefaultSandcastleExecutionClient()) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const ticket = request.plan.tickets[request.ticketIndex];
    if (!ticket)
      return { status: 'failed', sessionId: null, removable: false, unsafeReason: 'ticket missing in launch request' };

    const provider =
      request.invocationMode === 'reviewer' ? request.plan.reviewerSandcastleProvider : request.plan.sandcastleProvider;
    request.onProgress?.({
      ticketLabel: ticket.label,
      message: `starting Sandcastle ${request.invocationMode ?? 'execution'} phase`,
    });
    const result = await this.client.execute({ request, provider });
    request.onProgress?.({
      ticketLabel: ticket.label,
      message: `Sandcastle ${request.invocationMode ?? 'execution'} phase ${result.status}`,
      sessionId: result.sessionId ?? null,
      kind: result.status === 'completed' ? undefined : 'failure',
    });
    return result;
  }
}
