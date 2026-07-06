import { Codex } from '@openai/codex-sdk';
import type { OpenCodeSessionExecutor, OpenCodeSessionProgressEvent } from './opencode.js';
import { buildStaleRecoveryPrompt } from './opencode.js';
import type { LaunchModel } from './types.js';

const DEFAULT_CODEX_MODEL: LaunchModel = { id: 'codex/default', label: 'Default' };
const DEFAULT_STALE_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_STALE_RECOVERIES = 5;
const DEFAULT_CODEX_SANDBOX_MODE: SandboxMode = 'workspace-write';
const DEFAULT_CODEX_APPROVAL_POLICY: ApprovalMode = 'never';
const DEFAULT_CODEX_NETWORK_ACCESS = false;
const CODEX_SANDBOX_MODES = new Set<SandboxMode>(['read-only', 'workspace-write', 'danger-full-access']);
const CODEX_APPROVAL_POLICIES = new Set<ApprovalMode>(['never', 'on-request', 'on-failure', 'untrusted']);

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type ApprovalMode = 'never' | 'on-request' | 'on-failure' | 'untrusted';
type ThreadOptions = Record<string, unknown>;

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

type CodexThreadEventLike = Record<string, unknown>;

export type CodexClientFactory = () => CodexClientLike | Promise<CodexClientLike>;

interface CodexActiveToolState {
  message: string;
  lastSeenAt: number;
}

export async function discoverCodexModels(
  env: NodeJS.ProcessEnv = process.env,
  _repoRoot?: string,
): Promise<LaunchModel[]> {
  const configuredModels = (env.AFK_CODEX_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return [DEFAULT_CODEX_MODEL, ...configuredModels.map((model) => ({ id: `codex/${model}`, label: model }))];
}

export class CodexSessionExecutor implements OpenCodeSessionExecutor {
  constructor(private readonly factory: CodexClientFactory = createDefaultCodexClient) {}

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
    sandboxMode?: SandboxMode;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
    signal?: AbortSignal;
  }): Promise<{
    sessionId?: string | null;
    output: string[];
    terminalError?: string | null;
    finalMessageText?: string | null;
  }> {
    const threadOptions = buildCodexThreadOptions(input.model, input.workDir, process.env, input.sandboxMode);
    const output: string[] = [];
    let finalMessageText: string | null = null;
    let terminalError: string | null = null;
    let sessionId = input.sessionId?.trim() || null;
    let staleRecoveries = 0;
    let promptText = input.prompt;
    let lastMeaningfulProgressAt = Date.now();
    let activeTool: CodexActiveToolState | null = null;
    const staleProgressTimeoutMs = input.staleProgressTimeoutMs ?? DEFAULT_STALE_PROGRESS_TIMEOUT_MS;
    const activeToolStaleTimeoutMs = input.activeToolStaleTimeoutMs ?? DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS;
    const maxStaleRecoveries = input.maxStaleRecoveries ?? DEFAULT_MAX_STALE_RECOVERIES;
    const onProgress = (event: OpenCodeSessionProgressEvent) => {
      input.onProgress?.(event);
      if (!isMeaningfulProgress(event)) return;
      const now = Date.now();
      lastMeaningfulProgressAt = now;
      activeTool = updateActiveToolState(activeTool, event, now);
    };

    try {
      const client = await this.factory();
      const thread = sessionId ? client.resumeThread(sessionId, threadOptions) : client.startThread(threadOptions);
      onProgress({
        message: sessionId ? `resuming codex thread ${sessionId}` : 'starting codex thread',
        sessionId,
      });

      while (true) {
        if (input.signal?.aborted) {
          terminalError = 'run killed';
          onProgress({ message: terminalError, sessionId });
          break;
        }

        onProgress({
          message: staleRecoveries
            ? `sent recovery prompt to codex (${staleRecoveries}/${maxStaleRecoveries})`
            : 'sent prompt to codex',
          sessionId,
        });
        const turnController = new AbortController();
        const abortTurn = () => turnController.abort();
        input.signal?.addEventListener('abort', abortTurn, { once: true });
        const consumeResult = await consumeCodexTurn({
          streamed: thread.runStreamed(promptText, { signal: turnController.signal }),
          onEvent: (event) => {
            sessionId = extractSessionId(event) || sessionId;
            const agentText = extractAgentMessageText(event);
            if (agentText) {
              output.push(agentText);
              finalMessageText = agentText;
            }
            const progress = parseCodexEvent(event, sessionId);
            if (progress) onProgress(progress);
          },
          onAbort: abortTurn,
          staleProgressTimeoutMs,
          activeToolStaleTimeoutMs,
          getLastMeaningfulProgressAt: () => lastMeaningfulProgressAt,
          getActiveTool: () => activeTool,
          signal: input.signal,
        });
        input.signal?.removeEventListener('abort', abortTurn);

        if (consumeResult.status === 'completed') {
          break;
        }
        if (consumeResult.status === 'failed') {
          terminalError = consumeResult.message;
          onProgress({ message: terminalError, sessionId });
          break;
        }
        if (consumeResult.status === 'aborted') {
          terminalError = consumeResult.message;
          onProgress({ message: terminalError, sessionId });
          break;
        }

        staleRecoveries += 1;
        onProgress({ message: consumeResult.message, sessionId });
        if (staleRecoveries > maxStaleRecoveries) {
          terminalError = `codex session stale after ${maxStaleRecoveries} recovery attempts`;
          onProgress({ message: terminalError, sessionId });
          break;
        }
        onProgress({ message: `codex stale recovery attempt ${staleRecoveries}/${maxStaleRecoveries}`, sessionId });
        lastMeaningfulProgressAt = Date.now();
        activeTool = null;
        promptText = buildStaleRecoveryPrompt(input.prompt, staleRecoveries, maxStaleRecoveries, 'Codex');
      }

      sessionId = sessionId || thread.id;
      onProgress({
        message: terminalError ? `codex thread failed: ${terminalError}` : 'codex thread completed',
        sessionId,
      });
      return { sessionId, output, terminalError, finalMessageText };
    } catch (error) {
      const reason = input.signal?.aborted ? 'run killed' : formatCodexExecutionError(error);
      return {
        sessionId,
        output,
        terminalError: reason,
        finalMessageText,
      };
    }
  }
}

async function consumeCodexTurn(input: {
  streamed: Promise<{ events: AsyncIterable<CodexThreadEventLike> }>;
  onEvent: (event: CodexThreadEventLike) => void;
  onAbort: () => void;
  staleProgressTimeoutMs: number;
  activeToolStaleTimeoutMs: number;
  getLastMeaningfulProgressAt: () => number;
  getActiveTool: () => CodexActiveToolState | null;
  signal?: AbortSignal;
}): Promise<
  | { status: 'completed' }
  | { status: 'failed'; message: string }
  | { status: 'stale'; message: string }
  | { status: 'aborted'; message: string }
> {
  let iterator: AsyncIterator<CodexThreadEventLike> | null = null;
  let nextPromise: Promise<IteratorResult<CodexThreadEventLike>> | null = null;
  const streamPromise = input.streamed.then((streamed) => streamed.events[Symbol.asyncIterator]());

  while (true) {
    if (input.signal?.aborted) {
      input.onAbort();
      return { status: 'aborted', message: 'run killed' };
    }
    const activeTool = input.getActiveTool();
    const timeoutMs = activeTool ? input.activeToolStaleTimeoutMs : input.staleProgressTimeoutMs;
    const lastProgressAt = activeTool ? activeTool.lastSeenAt : input.getLastMeaningfulProgressAt();
    const remaining = timeoutMs - (Date.now() - lastProgressAt);
    if (remaining <= 0) {
      input.onAbort();
      return {
        status: 'stale',
        message: activeTool
          ? `codex tool stale after ${formatDuration(timeoutMs)}: ${activeTool.message}; interrupting turn`
          : `codex session stale after ${formatDuration(timeoutMs)}; interrupting turn`,
      };
    }

    if (!iterator) {
      const result = await Promise.race([streamPromise, delay(Math.min(remaining, 1_000)), aborted(input.signal)]);
      if (result === 'tick') continue;
      if (result === 'aborted') {
        input.onAbort();
        return { status: 'aborted', message: 'run killed' };
      }
      iterator = result as AsyncIterator<CodexThreadEventLike>;
      nextPromise = iterator.next();
    }

    if (!nextPromise) {
      nextPromise = iterator.next();
    }

    const result = await Promise.race([nextPromise, delay(Math.min(remaining, 1_000)), aborted(input.signal)]);
    if (result === 'tick') continue;
    if (result === 'aborted') {
      input.onAbort();
      return { status: 'aborted', message: 'run killed' };
    }

    const next = result as IteratorResult<CodexThreadEventLike>;
    if (next.done) return { status: 'completed' };
    const event = next.value;
    input.onEvent(event);
    const failure = extractTerminalFailure(event);
    if (failure) return { status: 'failed', message: failure };
    nextPromise = iterator.next();
  }
}

export function buildCodexThreadOptions(
  model: LaunchModel,
  workDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  sandboxMode?: SandboxMode,
): ThreadOptions {
  const options: ThreadOptions = {
    sandboxMode: sandboxMode ?? parseCodexSandboxMode(env.AFK_CODEX_SANDBOX),
    approvalPolicy: parseCodexApprovalPolicy(env.AFK_CODEX_APPROVAL),
    networkAccessEnabled: parseCodexBoolean(env.AFK_CODEX_NETWORK),
  };
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

export function parseCodexSandboxMode(value: string | undefined): SandboxMode {
  const normalized = value?.trim();
  return normalized && CODEX_SANDBOX_MODES.has(normalized as SandboxMode)
    ? (normalized as SandboxMode)
    : DEFAULT_CODEX_SANDBOX_MODE;
}

export function parseCodexApprovalPolicy(value: string | undefined): ApprovalMode {
  const normalized = value?.trim();
  return normalized && CODEX_APPROVAL_POLICIES.has(normalized as ApprovalMode)
    ? (normalized as ApprovalMode)
    : DEFAULT_CODEX_APPROVAL_POLICY;
}

export function parseCodexBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return DEFAULT_CODEX_NETWORK_ACCESS;
}

async function createDefaultCodexClient(): Promise<CodexClientLike> {
  return new Codex();
}

function formatCodexExecutionError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'codex execution failed';
  if (typeof error === 'string') return error || 'codex execution failed';
  if (error === null || error === undefined) return 'codex execution failed';
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractAgentMessageText(event: CodexThreadEventLike): string | null {
  if (event.type !== 'item.completed' && event.type !== 'item.updated') return null;
  const item = (event as { item?: unknown }).item;
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (record.type !== 'agent_message') return null;
  return stringValue(record.text);
}

export function parseCodexEvent(
  event: CodexThreadEventLike,
  sessionId?: string | null,
): OpenCodeSessionProgressEvent | null {
  const type = stringValue((event as { type?: unknown }).type)?.toLowerCase();
  if (!type) return null;
  if (type === 'thread.started') {
    const id = extractSessionId(event) || sessionId || null;
    return { message: `created codex thread ${id || 'unknown'}`, sessionId: id };
  }
  if (type === 'turn.started') return { message: 'codex turn started', sessionId };
  if (type === 'turn.completed') return { message: 'codex turn completed', sessionId };
  if (type === 'turn.failed' || type === 'error') {
    return { message: extractTerminalFailure(event) ?? 'codex turn failed', sessionId };
  }

  const item = recordValue((event as { item?: unknown }).item) ?? (event as Record<string, unknown>);
  const itemType = stringValue(item.type)?.toLowerCase() ?? type;
  if (itemType === 'agent_message') {
    const text = stringValue(item.text);
    return text ? { kind: 'message', activity: 'assistant', message: text, sessionId } : null;
  }
  if (itemType.includes('command') || itemType.includes('exec') || itemType.includes('shell')) {
    const toolName = stringValue(item.tool) || stringValue(item.name) || stringValue(item.command_type) || 'bash';
    const command = stringValue(item.command) || stringValue(item.cmd) || stringValue(item.text);
    const status = normalizeToolStatus(stringValue(item.status) || statusFromEventType(type));
    const suffix = command ? `: ${command}` : '';
    return {
      kind: 'message',
      activity: 'tool',
      toolName,
      toolStatus: status,
      message: `tool ${toolName} ${status || 'running'}${suffix}`,
      sessionId,
    };
  }
  if (itemType.includes('mcp')) {
    const toolName = stringValue(item.name) || stringValue(item.tool) || 'mcp';
    const status = normalizeToolStatus(stringValue(item.status) || statusFromEventType(type));
    return {
      kind: 'message',
      activity: 'tool',
      toolName,
      toolStatus: status,
      message: `tool ${toolName} ${status || 'running'}`,
      sessionId,
    };
  }
  if (itemType.includes('file') || itemType.includes('diff') || itemType.includes('patch')) {
    const filePath = stringValue(item.path) || stringValue(item.file) || stringValue(item.name);
    const action = stringValue(item.action) || stringValue(item.operation) || 'updated';
    return {
      kind: 'message',
      activity: 'diff',
      message: filePath ? `file ${action}: ${filePath}` : `file ${action}`,
      sessionId,
    };
  }
  return null;
}

function extractTerminalFailure(event: CodexThreadEventLike): string | null {
  const type = stringValue((event as { type?: unknown }).type)?.toLowerCase();
  if (type !== 'turn.failed' && type !== 'error') return null;
  if (type === 'turn.failed') return extractCodexError(event) ?? 'codex turn failed';
  return stringValue((event as { message?: unknown }).message) || extractCodexError(event) || 'codex stream error';
}

function extractSessionId(event: CodexThreadEventLike): string | null {
  return (
    stringValue((event as { thread_id?: unknown }).thread_id) ||
    stringValue((event as { threadId?: unknown }).threadId) ||
    stringValue((event as { thread?: { id?: unknown } }).thread?.id)
  );
}

function extractCodexError(event: CodexThreadEventLike): string | null {
  const error = (event as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  return stringValue((error as { message?: unknown }).message);
}

function isMeaningfulProgress(event: OpenCodeSessionProgressEvent): boolean {
  return Boolean(event.message.trim());
}

function updateActiveToolState(
  current: CodexActiveToolState | null,
  event: OpenCodeSessionProgressEvent,
  now: number,
): CodexActiveToolState | null {
  if (event.activity !== 'tool') return current;
  if (event.toolStatus === 'running') return { message: event.message, lastSeenAt: now };
  if (event.toolStatus === 'completed' || event.toolStatus === 'error') return null;
  return current ? { ...current, message: event.message, lastSeenAt: now } : current;
}

function normalizeToolStatus(status: string | null): string | null {
  if (!status) return 'running';
  const lower = status.toLowerCase();
  if (lower === 'failed' || lower === 'failure') return 'error';
  if (lower === 'started' || lower === 'in_progress') return 'running';
  if (lower === 'done' || lower === 'success') return 'completed';
  return lower;
}

function statusFromEventType(type: string): string | null {
  if (type.endsWith('.started')) return 'running';
  if (type.endsWith('.completed')) return 'completed';
  if (type.endsWith('.failed')) return 'error';
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function delay(ms: number): Promise<'tick'> {
  return new Promise((resolve) => setTimeout(() => resolve('tick'), ms));
}

function aborted(signal?: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
