import type { AgentExecutionProgressEvent } from './types.js';
import { createProgressLine } from './progress-line.js';

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
}

export function createLiveRunView(options: LiveRunViewOptions): LiveRunView {
  const { kind = 'text', stdout, isPromptActive, providerName } = options;
  if (kind === 'dashboard') {
    // Dashboard view is not yet implemented; fall back to text progress line.
    // This keeps the seam stable while the OpenTUI integration is built separately.
    return createProgressLine(stdout, { isPromptActive, providerName });
  }
  return createProgressLine(stdout, { isPromptActive, providerName });
}
