import { createOpenTuiDashboard, DashboardProxy } from './opentui-dashboard.js';
import { createProgressLine } from './progress-line.js';
import type { RunDashboardStateOptions } from './run-dashboard-state.js';
import type { AgentExecutionProgressEvent, TicketRecord } from './types.js';

export interface LiveRunView {
  update(event: AgentExecutionProgressEvent): void;
  done(): void;
  cleanup(): void;
}

export type LiveRunViewKind = 'text' | 'dashboard';

export interface LiveRunViewOptions {
  kind?: LiveRunViewKind;
  stdout: NodeJS.WriteStream;
  isPromptActive?: () => boolean;
  providerName?: string;
  selectedTickets?: TicketRecord[];
  runOptions?: RunDashboardStateOptions;
  repoRoot?: string;
}

export function createLiveRunView(options: LiveRunViewOptions): LiveRunView {
  const { kind = 'text', stdout, isPromptActive, providerName, selectedTickets, runOptions, repoRoot } = options;
  if (kind === 'dashboard' && stdout.isTTY) {
    const proxy = new DashboardProxy(
      stdout,
      { isPromptActive, providerName },
      { stdout, selectedTickets, runOptions, repoRoot },
      (opts) => createOpenTuiDashboard(opts),
    );
    proxy.start().catch(() => {});
    return proxy;
  }
  return createProgressLine(stdout, { isPromptActive, providerName });
}
