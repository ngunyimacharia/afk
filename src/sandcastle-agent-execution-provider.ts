import type { AgentExecutionProvider, AgentExecutionRequest } from './agent-execution-provider.js';
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

export class SandcastleAgentExecutionProvider implements AgentExecutionProvider {
  constructor(private readonly client: SandcastlePhaseExecutionClient = new MissingSandcastleExecutionClient()) {}

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
