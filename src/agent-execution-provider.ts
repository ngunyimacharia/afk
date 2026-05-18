import type { AgentExecutionResult, LaunchPlan } from './types.js';

export interface AgentExecutionRequest {
  plan: LaunchPlan;
  ticketIndex: number;
  prompt: string;
}

export interface AgentExecutionProvider {
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}

export class FakeAgentExecutionProvider implements AgentExecutionProvider {
  constructor(private readonly result: AgentExecutionResult) {}

  async execute(): Promise<AgentExecutionResult> {
    return this.result;
  }
}
