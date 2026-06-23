import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  PermissionResult,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKToolProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveExecutable } from './executable-resolution.js';
import type {
  OpenCodePermissionDecision,
  OpenCodePermissionRequest,
  OpenCodeSessionExecutor,
  OpenCodeSessionProgressEvent,
} from './opencode.js';
import { buildStaleRecoveryPrompt, parseModelId } from './opencode.js';
import type { LaunchModel } from './types.js';

export const DEFAULT_STALE_PROGRESS_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_MAX_STALE_RECOVERIES = 3;
const KIMI_BASE_URL = 'https://api.kimi.com/coding/';
const CLAUDE_LOCAL_SETTINGS_PATH = '.claude/settings.local.json';

const ANTHROPIC_MODELS: LaunchModel[] = [
  { id: 'anthropic/claude-opus-4', label: 'Claude Opus 4' },
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'anthropic/claude-haiku-4', label: 'Claude Haiku 4' },
];

let cachedClaudeCodePath: string | undefined | null = null;

function resolveClaudeCodeExecutablePath(): string | undefined {
  if (cachedClaudeCodePath !== null) return cachedClaudeCodePath ?? undefined;

  try {
    const whichPath = resolveExecutable('which');
    const executablePath = execFileSync(whichPath, ['claude'], { encoding: 'utf8' }).trim();
    cachedClaudeCodePath = executablePath;
    return executablePath;
  } catch {
    cachedClaudeCodePath = undefined;
    return undefined;
  }
}

export function isClaudeCodeInstalled(): boolean {
  return !!resolveClaudeCodeExecutablePath();
}

export function resetClaudeCodeExecutablePathCache(): void {
  cachedClaudeCodePath = null;
}

interface ClaudeRepoConfig {
  env: Record<string, string | undefined>;
  isKimi: boolean;
  source: 'file' | 'executable' | 'none';
}

function isKimiEndpoint(baseUrl: string | undefined): boolean {
  return typeof baseUrl === 'string' && baseUrl.includes('kimi.com');
}

export interface ClaudeRepoConfigDeps {
  isClaudeCodeInstalled?: () => boolean;
}

export function resolveClaudeRepoConfig(repoRoot: string, deps: ClaudeRepoConfigDeps = {}): ClaudeRepoConfig {
  const settingsPath = path.join(repoRoot, CLAUDE_LOCAL_SETTINGS_PATH);
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'env' in parsed) {
      const fileEnv = (parsed as { env?: Record<string, unknown> }).env;
      if (fileEnv && typeof fileEnv === 'object') {
        const stringEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(fileEnv)) {
          if (typeof value === 'string') stringEnv[key] = value;
        }
        const mergedEnv = { ...process.env, ...stringEnv };
        return {
          env: mergedEnv,
          isKimi: isKimiEndpoint(mergedEnv.ANTHROPIC_BASE_URL),
          source: 'file',
        };
      }
    }
  } catch {
    // File missing or invalid; fall through to executable detection.
  }

  const installed = deps.isClaudeCodeInstalled ? deps.isClaudeCodeInstalled() : isClaudeCodeInstalled();
  if (installed) {
    return { env: { ...process.env }, isKimi: false, source: 'executable' };
  }

  return { env: { ...process.env }, isKimi: false, source: 'none' };
}

export async function discoverClaudeModels(repoRoot?: string, deps: ClaudeRepoConfigDeps = {}): Promise<LaunchModel[]> {
  const config = resolveClaudeRepoConfig(repoRoot ?? process.cwd(), deps);
  if (config.source === 'none') return [];

  if (config.isKimi) {
    return [{ id: 'kimi/kimi-for-coding', label: 'Kimi for Coding' }];
  }

  return ANTHROPIC_MODELS;
}

export class ClaudeCodeSessionExecutor implements OpenCodeSessionExecutor {
  constructor(private readonly repoRoot: string) {}

  async run(input: {
    model: LaunchModel;
    prompt: string;
    title: string;
    agent?: string;
    sessionId?: string | null;
    workDir?: string;
    staleProgressTimeoutMs?: number;
    activeToolStaleTimeoutMs?: number;
    maxStaleRecoveries?: number;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
    decidePermission?: (request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null>;
    signal?: AbortSignal;
  }): Promise<{
    sessionId?: string | null;
    output: string[];
    terminalError?: string | null;
    finalMessageText?: string | null;
  }> {
    const [, modelID] = parseModelId(input.model.id);
    const model = modelID || input.model.id;
    const sessionId = input.sessionId ?? randomUUID();
    const isResumingFromPreviousRun = !!input.sessionId;

    const config = resolveClaudeRepoConfig(this.repoRoot);
    const env: Record<string, string | undefined> = { ...config.env };
    if (config.isKimi && !env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = KIMI_BASE_URL;
    }

    const staleProgressTimeoutMs = input.staleProgressTimeoutMs ?? DEFAULT_STALE_PROGRESS_TIMEOUT_MS;
    const activeToolStaleTimeoutMs = input.activeToolStaleTimeoutMs ?? DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS;
    const maxStaleRecoveries = input.maxStaleRecoveries ?? DEFAULT_MAX_STALE_RECOVERIES;

    let staleRecoveries = 0;
    let promptText = input.prompt;
    const output: string[] = [];
    let finalMessageText: string | null = null;
    let terminalError: string | null = null;

    const onProgress = (event: OpenCodeSessionProgressEvent) => {
      input.onProgress?.(event);
    };

    onProgress({
      message: isResumingFromPreviousRun
        ? `resuming claude session ${sessionId}`
        : `created claude session ${sessionId}`,
      sessionId,
    });

    while (true) {
      if (input.signal?.aborted) {
        onProgress({ message: 'run killed', sessionId });
        break;
      }

      const isRecovery = staleRecoveries > 0;
      const shouldResume = isResumingFromPreviousRun || isRecovery;

      const queryHandle = query({
        prompt: promptText,
        options: {
          model,
          ...(shouldResume ? { resume: sessionId } : { sessionId }),
          cwd: input.workDir,
          agent: input.agent,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          canUseTool: input.decidePermission
            ? async (): Promise<PermissionResult> => {
                const decision = await input.decidePermission?.({
                  sessionId,
                  permissionId: 'claude-tool',
                  type: 'tool',
                  title: 'Claude tool execution',
                  patterns: [],
                });
                return decision === 'reject'
                  ? { behavior: 'deny', message: 'permission denied by user' }
                  : { behavior: 'allow' };
              }
            : async (): Promise<PermissionResult> => ({ behavior: 'allow' }),
          settingSources: [],
          env,
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
        },
      });

      const consumeResult = await consumeClaudeCodeQuery(
        queryHandle,
        onProgress,
        staleProgressTimeoutMs,
        activeToolStaleTimeoutMs,
        (msg) => {
          if (isAssistantMessage(msg)) {
            const lines = extractTextFromAssistantMessage(msg);
            output.push(...lines);
            finalMessageText = lines.join('\n') || finalMessageText;
          }
          if (isResultMessage(msg)) {
            if (msg.subtype !== 'success') {
              terminalError = `claude error: ${msg.subtype}`;
              if ('errors' in msg && Array.isArray(msg.errors)) {
                const errorText = msg.errors.join('; ');
                if (errorText) terminalError = errorText;
              }
            } else if (msg.result) {
              finalMessageText = msg.result;
            }
          }
        },
        input.signal,
      );

      if (consumeResult.completed) {
        onProgress({ message: 'claude prompt completed', sessionId });
        break;
      }

      if (consumeResult.staleMessage === 'run killed') {
        onProgress({ message: 'run killed', sessionId });
        break;
      }

      staleRecoveries += 1;
      const staleWhile = consumeResult.staleToolName ? ` stale while: ${consumeResult.staleToolName};` : '';
      onProgress({
        message: `${consumeResult.staleMessage ?? 'claude session stale'}${staleWhile}`,
        sessionId,
      });

      if (staleRecoveries > maxStaleRecoveries) {
        terminalError = `claude session stale after ${maxStaleRecoveries} recovery attempts${staleWhile}`;
        onProgress({ message: terminalError, sessionId });
        break;
      }

      onProgress({
        message: `claude stale recovery attempt ${staleRecoveries}/${maxStaleRecoveries}`,
        sessionId,
      });

      promptText = buildStaleRecoveryPrompt(
        input.prompt,
        staleRecoveries,
        maxStaleRecoveries,
        'Claude',
        consumeResult.staleToolName,
      );
    }

    return {
      sessionId,
      output,
      terminalError,
      finalMessageText,
    };
  }
}

async function consumeClaudeCodeQuery(
  queryHandle: Query,
  onProgress: (event: OpenCodeSessionProgressEvent) => void,
  staleProgressTimeoutMs: number,
  activeToolStaleTimeoutMs: number,
  onMessage: (msg: SDKMessage) => void,
  signal?: AbortSignal,
): Promise<{ completed: boolean; staleMessage?: string; staleToolName?: string | null }> {
  let lastMeaningfulProgressAt = Date.now();
  let activeTool: { message: string; toolName?: string | null; lastSeenAt: number } | null = null;
  const iterator = queryHandle[Symbol.asyncIterator]();

  let nextPromise = iterator.next();

  try {
    while (true) {
      if (signal?.aborted) {
        await queryHandle.interrupt();
        return { completed: false, staleMessage: 'run killed' };
      }

      const currentActiveTool = activeTool;
      const timeoutMs = currentActiveTool ? activeToolStaleTimeoutMs : staleProgressTimeoutMs;
      const lastProgressAt = currentActiveTool ? currentActiveTool.lastSeenAt : lastMeaningfulProgressAt;
      const remaining = timeoutMs - (Date.now() - lastProgressAt);

      if (remaining <= 0) {
        await queryHandle.interrupt();
        return {
          completed: false,
          staleMessage: currentActiveTool
            ? `claude tool stale after ${formatDuration(timeoutMs)}: ${currentActiveTool.message}; interrupting session`
            : `claude session stale after ${formatDuration(timeoutMs)}; interrupting session`,
          staleToolName: currentActiveTool?.toolName,
        };
      }

      const result = await Promise.race([
        nextPromise,
        new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), Math.min(remaining, 1_000))),
        new Promise<'aborted'>((resolve) => {
          if (signal?.aborted) {
            resolve('aborted');
            return;
          }
          signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
        }),
      ]);

      if (result === 'tick') continue;
      if (result === 'aborted') {
        await queryHandle.interrupt();
        return { completed: false, staleMessage: 'run killed' };
      }

      if (result.done) {
        return { completed: true };
      }

      const message = result.value;
      onMessage(message);

      const event = parseClaudeCodeEvent(message);
      if (event) {
        onProgress(event);
        if (isMeaningfulProgress(event)) {
          const now = Date.now();
          lastMeaningfulProgressAt = now;
          activeTool = updateActiveToolState(activeTool, event, now);
        }
      }

      nextPromise = iterator.next();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { completed: false, staleMessage: `claude query error: ${message}` };
  } finally {
    queryHandle.close();
  }
}

export function parseClaudeCodeEvent(message: unknown): OpenCodeSessionProgressEvent | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case 'assistant': {
      const assistantMsg = msg as unknown as SDKAssistantMessage;
      const lines = extractTextFromAssistantMessage(assistantMsg);
      const lastLine = lines.at(-1) ?? '';
      if (!lastLine) return null;
      return {
        kind: 'message',
        message: lastLine,
        activity: 'assistant',
        sessionId: assistantMsg.session_id,
      };
    }
    case 'tool_progress': {
      const toolMsg = msg as unknown as SDKToolProgressMessage;
      return {
        kind: 'message',
        message: `tool ${toolMsg.tool_name} running`,
        activity: 'tool',
        toolName: toolMsg.tool_name,
        toolStatus: 'running',
        sessionId: toolMsg.session_id,
      };
    }
    case 'result': {
      const resultMsg = msg as unknown as SDKResultMessage;
      if (resultMsg.subtype !== 'success') {
        return {
          kind: 'message',
          message: `claude result error: ${resultMsg.subtype}`,
          activity: 'session',
          sessionId: resultMsg.session_id,
        };
      }
      return null;
    }
    case 'system': {
      const subtype = msg.subtype;
      if (subtype === 'compact_boundary') {
        return {
          kind: 'message',
          message: 'claude context compaction started',
          activity: 'session',
          sessionId: String(msg.session_id ?? ''),
        };
      }
      if (subtype === 'session_state_changed') {
        return {
          kind: 'message',
          message: `claude session ${msg.state}`,
          activity: 'session',
          sessionId: String(msg.session_id ?? ''),
        };
      }
      if (subtype === 'permission_denied') {
        const toolName = String(msg.tool_name ?? 'unknown');
        const reason = String(msg.message ?? '');
        return {
          kind: 'permission',
          message: `claude permission denied: ${toolName}${reason ? ` - ${reason}` : ''}`,
          activity: 'permission',
          sessionId: String(msg.session_id ?? ''),
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function isAssistantMessage(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === 'assistant';
}

function isResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === 'result';
}

function extractTextFromAssistantMessage(msg: SDKAssistantMessage): string[] {
  const message = msg.message as { content?: unknown[] };
  if (!Array.isArray(message.content)) return [];
  const lines: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue;
    const blockObj = block as Record<string, unknown>;
    if (typeof blockObj.text === 'string') {
      lines.push(...splitNonEmptyLines(blockObj.text));
    }
    if (typeof blockObj.thinking === 'string') {
      lines.push(...splitNonEmptyLines(blockObj.thinking));
    }
  }
  return lines;
}

function splitNonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isMeaningfulProgress(event: OpenCodeSessionProgressEvent): boolean {
  if (event.kind === 'permission') return true;
  return Boolean(event.message.trim());
}

function updateActiveToolState(
  current: { message: string; toolName?: string | null; lastSeenAt: number } | null,
  event: OpenCodeSessionProgressEvent,
  now: number,
): { message: string; toolName?: string | null; lastSeenAt: number } | null {
  if (event.activity !== 'tool') return current;
  if (event.toolStatus === 'running') {
    return { message: event.message, toolName: event.toolName, lastSeenAt: now };
  }
  if (event.toolStatus === 'completed' || event.toolStatus === 'error') return null;
  return current ? { ...current, message: event.message, lastSeenAt: now } : current;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
