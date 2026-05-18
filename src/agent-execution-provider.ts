import type { AgentExecutionProgressCallback, AgentExecutionResult, LaunchPlan } from './types.js';
import type { OpenCodeSessionExecutor } from './opencode.js';

export interface AgentExecutionRequest {
  plan: LaunchPlan;
  ticketIndex: number;
  prompt: string;
  onProgress?: AgentExecutionProgressCallback;
}

export interface AgentExecutionProvider {
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}

export class FakeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(private readonly result: AgentExecutionResult) {}

  async execute(_request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.result;
  }
}

export class OpenCodeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(private readonly executor: OpenCodeSessionExecutor) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const ticket = request.plan.tickets[request.ticketIndex];
    if (!ticket) return { status: 'failed', sessionId: null, removable: false, unsafeReason: 'ticket missing in launch request' };
    try {
      request.onProgress?.({ ticketLabel: ticket.label, message: 'starting opencode session' });
      const result = await this.executor.run({
        model: request.plan.model,
        prompt: request.prompt,
        title: `afk: ${ticket.label}`,
        agent: 'build',
        onProgress: (event) => request.onProgress?.({ ticketLabel: ticket.label, ...event }),
      });
      const failureReason = detectOpenCodeFailure(result.output ?? []);
      request.onProgress?.({ ticketLabel: ticket.label, message: failureReason ? `opencode session failed: ${failureReason}` : 'opencode session completed', sessionId: result.sessionId ?? null });
      return {
        status: failureReason ? 'failed' : 'completed',
        sessionId: result.sessionId ?? null,
        removable: !failureReason,
        output: result.output,
        unsafeReason: failureReason ?? (result.sessionId ? null : 'session id unavailable from opencode'),
      };
    } catch (error) {
      request.onProgress?.({ ticketLabel: ticket.label, message: `opencode execution failed: ${error instanceof Error ? error.message : 'unknown error'}` });
      return {
        status: 'failed',
        sessionId: null,
        removable: false,
        unsafeReason: error instanceof Error ? error.message : 'opencode execution failed',
        output: ['opencode execution failed'],
      };
    }
  }
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
