import { Codex } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import type { OpenCodeSessionExecutor, OpenCodeSessionProgressEvent } from './opencode.js';
import type { LaunchModel } from './types.js';

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<CodexThreadEventLike> }>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

type CodexThreadEventLike = ThreadEvent | Record<string, unknown>;

export type CodexClientFactory = () => CodexClientLike;

export class CodexSessionExecutor implements OpenCodeSessionExecutor {
  constructor(private readonly factory: CodexClientFactory = () => new Codex()) {}

  async run(input: {
    model: LaunchModel;
    prompt: string;
    title: string;
    agent?: string;
    sessionId?: string | null;
    workDir?: string;
    repoRoot?: string;
    staleProgressTimeoutMs?: number;
    activeToolStaleTimeoutMs?: number;
    maxStaleRecoveries?: number;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
    signal?: AbortSignal;
  }): Promise<{
    sessionId?: string | null;
    output: string[];
    terminalError?: string | null;
    finalMessageText?: string | null;
  }> {
    const threadOptions = buildCodexThreadOptions(input.model, input.workDir);
    const output: string[] = [];
    let finalMessageText: string | null = null;
    let terminalError: string | null = null;
    let sessionId = input.sessionId?.trim() || null;

    try {
      const client = this.factory();
      const thread = sessionId ? client.resumeThread(sessionId, threadOptions) : client.startThread(threadOptions);
      input.onProgress?.({
        message: sessionId ? `resuming codex thread ${sessionId}` : 'starting codex thread',
        sessionId,
      });

      const streamed = await thread.runStreamed(input.prompt, { signal: input.signal });
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') {
          sessionId = stringValue((event as { thread_id?: unknown }).thread_id) || sessionId;
          input.onProgress?.({ message: `created codex thread ${sessionId || 'unknown'}`, sessionId });
          continue;
        }

        if (event.type === 'turn.failed') {
          terminalError = extractCodexError(event) ?? 'codex turn failed';
          input.onProgress?.({ message: terminalError, sessionId });
          continue;
        }

        if (event.type === 'error') {
          terminalError = stringValue((event as { message?: unknown }).message) || 'codex stream error';
          input.onProgress?.({ message: terminalError, sessionId });
          continue;
        }

        const agentText = extractAgentMessageText(event);
        if (agentText) {
          output.push(agentText);
          finalMessageText = agentText;
          input.onProgress?.({ kind: 'message', activity: 'assistant', message: agentText, sessionId });
        }
      }

      sessionId = sessionId || thread.id;
      input.onProgress?.({ message: terminalError ? `codex thread failed: ${terminalError}` : 'codex thread completed', sessionId });
      return { sessionId, output, terminalError, finalMessageText };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'codex execution failed';
      return {
        sessionId,
        output,
        terminalError: reason,
        finalMessageText,
      };
    }
  }
}

export function buildCodexThreadOptions(model: LaunchModel, workDir?: string): ThreadOptions {
  const options: ThreadOptions = {};
  const codexModel = parseCodexModel(model.id);
  if (codexModel) options.model = codexModel;
  if (workDir) options.workingDirectory = workDir;
  return options;
}

export function parseCodexModel(modelId: string): string | null {
  const prefix = 'codex/';
  if (!modelId.startsWith(prefix)) return modelId.trim() || null;
  const model = modelId.slice(prefix.length).trim();
  return model && model !== 'default' ? model : null;
}

function extractAgentMessageText(event: CodexThreadEventLike): string | null {
  if (event.type !== 'item.completed' && event.type !== 'item.updated') return null;
  const item = (event as { item?: unknown }).item;
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (record.type !== 'agent_message') return null;
  return stringValue(record.text);
}

function extractCodexError(event: CodexThreadEventLike): string | null {
  const error = (event as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  return stringValue((error as { message?: unknown }).message);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
