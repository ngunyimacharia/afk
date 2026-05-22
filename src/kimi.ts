import { chmod, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, KimiPaths, parseConfig, type StreamEvent, type Turn } from '@moonshot-ai/kimi-agent-sdk';
import { collectText, extractTextFromContentParts } from '@moonshot-ai/kimi-agent-sdk/utils';
import type {
  OpenCodePermissionDecision,
  OpenCodePermissionRequest,
  OpenCodeSessionExecutor,
  OpenCodeSessionProgressEvent,
} from './opencode.js';
import { buildStaleRecoveryPrompt } from './opencode.js';
import type { LaunchModel } from './types.js';

const DEFAULT_STALE_PROGRESS_TIMEOUT_MS = 120_000;
const DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_STALE_RECOVERIES = 3;
const EMPTY_KIMI_CONFIG = '{}';

interface KimiActiveToolState {
  message: string;
  lastSeenAt: number;
}

export async function discoverKimiModels(): Promise<LaunchModel[]> {
  try {
    const config = parseConfig();
    const models = config.models ?? [];
    const seen = new Set<string>();
    return models
      .map((model) => ({
        id: model.id,
        label: model.name || model.id,
      }))
      .filter((model) => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      });
  } catch {
    return [];
  }
}

export class KimiSessionExecutor implements OpenCodeSessionExecutor {
  constructor(private readonly factory: typeof createSession = createSession) {}

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
  }): Promise<{
    sessionId?: string | null;
    output: string[];
    terminalError?: string | null;
    finalMessageText?: string | null;
  }> {
    const workDir = input.workDir ?? process.cwd();
    const bareRuntime = await createBareKimiRuntime();
    let session: ReturnType<typeof createSession> | null = null;

    const abortController = new AbortController();
    let eventTask: Promise<void> | undefined;
    const terminalErrors: string[] = [];
    let lastMeaningfulProgressAt = Date.now();
    let activeTool: KimiActiveToolState | null = null;
    let staleRecoveries = 0;
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
      session = this.factory({
        workDir,
        model: input.model.id,
        sessionId: input.sessionId ?? undefined,
        yoloMode: true,
        executable: bareRuntime.executable,
        env: bareRuntime.env,
        shareDir: bareRuntime.shareDir,
        skillsDir: bareRuntime.skillsDir,
      });
      const sessionId = session.sessionId;
      onProgress({
        message: input.sessionId ? `resuming kimi session ${sessionId}` : `created kimi session ${sessionId}`,
        sessionId,
      });

      let promptText = input.prompt;
      const allTurnEvents: StreamEvent[][] = [];

      while (true) {
        onProgress({
          message: staleRecoveries
            ? `sent recovery prompt to kimi (${staleRecoveries}/${maxStaleRecoveries})`
            : 'sent prompt to kimi',
          sessionId,
        });

        const turn = session.prompt(promptText);
        const turnEvents: StreamEvent[] = [];

        eventTask = consumeKimiTurnEvents(
          turn,
          turnEvents,
          sessionId,
          onProgress,
          abortController.signal,
          input.decidePermission,
          terminalErrors,
        );

        const promptResult = await waitForTurnOrStale({
          turn,
          staleProgressTimeoutMs,
          activeToolStaleTimeoutMs,
          getLastMeaningfulProgressAt: () => lastMeaningfulProgressAt,
          getActiveTool: () => activeTool,
        });

        await settleEventTask(eventTask);
        allTurnEvents.push(turnEvents);

        if (promptResult === 'completed') break;

        staleRecoveries += 1;
        onProgress({
          message: promptResult.message,
          sessionId,
        });
        await Promise.race([
          turn.interrupt(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('turn interrupt timeout')), 10_000)),
        ]).catch(() => undefined);

        if (staleRecoveries > maxStaleRecoveries) {
          const sessionOutput = extractKimiSessionOutput(allTurnEvents);
          const terminalError = `kimi session stale after ${maxStaleRecoveries} recovery attempts`;
          onProgress({ message: terminalError, sessionId });
          return { sessionId, output: sessionOutput.lines, terminalError, finalMessageText: null };
        }

        onProgress({
          message: `kimi stale recovery attempt ${staleRecoveries}/${maxStaleRecoveries}`,
          sessionId,
        });
        lastMeaningfulProgressAt = Date.now();
        activeTool = null;
        promptText = buildStaleRecoveryPrompt(input.prompt, staleRecoveries, maxStaleRecoveries, 'kimi');
      }

      onProgress({ message: 'kimi prompt completed', sessionId });
      const sessionOutput = extractKimiSessionOutput(allTurnEvents);
      return {
        sessionId,
        output: sessionOutput.lines,
        terminalError: sessionOutput.finalMessageText
          ? null
          : (terminalErrors[0] ?? sessionOutput.terminalError ?? null),
        finalMessageText: sessionOutput.finalMessageText,
      };
    } finally {
      abortController.abort();
      await session?.close().catch(() => undefined);
      await bareRuntime.cleanup();
    }
  }
}

async function createBareKimiRuntime(): Promise<{
  executable: string;
  env: Record<string, string>;
  shareDir: string;
  skillsDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-kimi-bare-'));
  const wrapper = path.join(root, 'kimi-bare');
  const skillsDir = path.join(root, 'skills');
  const shareDir = path.join(root, 'share');
  const credentialsSource = path.join(KimiPaths.home, 'credentials');
  const credentialsDest = path.join(shareDir, 'credentials');

  await mkdir(skillsDir, { recursive: true });
  await mkdir(shareDir, { recursive: true });
  await cp(credentialsSource, credentialsDest, { recursive: true, force: true }).catch(() => undefined);
  await copyFile(path.join(KimiPaths.home, 'device_id'), path.join(shareDir, 'device_id')).catch(() => undefined);
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      'exec kimi --config-file "$AFK_KIMI_CONFIG_FILE" --mcp-config "$AFK_KIMI_EMPTY_MCP_CONFIG" --skills-dir "$AFK_KIMI_EMPTY_SKILLS_DIR" "$@"',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(wrapper, 0o755);

  return {
    executable: wrapper,
    env: {
      AFK_KIMI_CONFIG_FILE: KimiPaths.config,
      AFK_KIMI_EMPTY_MCP_CONFIG: EMPTY_KIMI_CONFIG,
      AFK_KIMI_EMPTY_SKILLS_DIR: skillsDir,
      KIMI_SHARE_DIR: shareDir,
    },
    shareDir,
    skillsDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function consumeKimiTurnEvents(
  turn: Turn,
  events: StreamEvent[],
  sessionId: string,
  onProgress: (event: OpenCodeSessionProgressEvent) => void,
  signal: AbortSignal,
  decidePermission: ((request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null>) | undefined,
  _terminalErrors: string[],
): Promise<void> {
  const handledPermissions = new Set<string>();
  try {
    for await (const event of turn) {
      if (signal.aborted) return;
      events.push(event);

      const progress = parseKimiEvent(event, sessionId);
      if (progress) onProgress(progress);

      if (event.type === 'ApprovalRequest') {
        const permission = parseKimiPermissionRequest(event, sessionId);
        if (!permission || handledPermissions.has(permission.permissionId)) continue;
        handledPermissions.add(permission.permissionId);

        const decision = await decidePermission?.(permission);
        if (!decision) continue;

        const mappedDecision = mapPermissionDecision(decision);
        await turn.approve(permission.permissionId, mappedDecision);

        onProgress({
          kind: 'message',
          message: `kimi permission ${decision}: ${permission.type}${permission.patterns.length ? ` for ${permission.patterns.join(', ')}` : ''}`,
          sessionId,
          permissionId: permission.permissionId,
          permissionPatterns: permission.patterns,
        });
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      onProgress({
        message: `kimi event stream unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
        sessionId,
      });
    }
  }
}

function parseKimiEvent(event: StreamEvent, sessionId: string): OpenCodeSessionProgressEvent | null {
  if (event.type === 'TurnBegin') {
    return messageProgress('kimi turn started', sessionId, { activity: 'session' });
  }
  if (event.type === 'StepBegin') {
    const payload = event.payload as { n?: number };
    return messageProgress(`kimi step ${payload.n ?? ''} started`.trim(), sessionId, { activity: 'session' });
  }
  if (event.type === 'StepInterrupted') {
    return messageProgress('kimi step interrupted', sessionId, { activity: 'session' });
  }
  if (event.type === 'ContentPart') {
    const payload = event.payload as { type: string; text?: string; think?: string };
    if ((payload.type === 'text' || payload.type === 'think') && payload.text) {
      const text = lastNonEmptyLine(payload.text);
      return messageProgress(text ? `${payload.type}: ${text}` : null, sessionId, { activity: 'assistant' });
    }
  }
  if (event.type === 'ToolCall') {
    const payload = event.payload as { function?: { name?: string } };
    const name = payload.function?.name ?? 'unknown';
    return messageProgress(`tool ${name} running`, sessionId, {
      activity: 'tool',
      toolName: name,
      toolStatus: 'running',
    });
  }
  if (event.type === 'ToolResult') {
    const payload = event.payload as {
      tool_call_id?: string;
      return_value?: { is_error: boolean; message?: string; output?: string | Array<{ type: string; text?: string }> };
    };
    const name = payload.tool_call_id ?? 'unknown';
    const isError = payload.return_value?.is_error ?? false;
    const status = isError ? 'error' : 'completed';
    const msg = isError
      ? `tool ${name} failed${payload.return_value?.message ? `: ${payload.return_value.message}` : ''}`
      : `tool ${name} completed`;
    return messageProgress(msg, sessionId, { activity: 'tool', toolName: name, toolStatus: status });
  }
  if (event.type === 'StatusUpdate') {
    const payload = event.payload as { token_usage?: { input_other?: number; output?: number } };
    const tokens = payload.token_usage;
    if (tokens) {
      return messageProgress(`tokens: ${tokens.input_other ?? '?'} in, ${tokens.output ?? '?'} out`, sessionId, {
        activity: 'other',
      });
    }
  }
  if (event.type === 'CompactionBegin') {
    return messageProgress('kimi context compaction started', sessionId, { activity: 'session' });
  }
  if (event.type === 'CompactionEnd') {
    return messageProgress('kimi context compaction finished', sessionId, { activity: 'session' });
  }
  if (event.type === 'error' || event.type === 'ParseError') {
    const payload = event as unknown as {
      payload?: { message?: string; code?: string };
      message?: string;
      code?: string;
    };
    const msg =
      payload.payload?.message ?? payload.message ?? payload.payload?.code ?? payload.code ?? 'kimi parse error';
    return messageProgress(`kimi error: ${msg}`, sessionId, { activity: 'session' });
  }
  return null;
}

function parseKimiPermissionRequest(event: StreamEvent, sessionId: string): OpenCodePermissionRequest | null {
  if (event.type !== 'ApprovalRequest') return null;
  const payload = event.payload as {
    id: string;
    action: string;
    description?: string;
  };
  const permissionId = payload.id;
  if (!permissionId) return null;
  return {
    sessionId,
    permissionId,
    type: payload.action ?? 'permission',
    title: payload.description ?? payload.action ?? 'permission',
    patterns: [],
  };
}

function mapPermissionDecision(decision: OpenCodePermissionDecision): 'approve' | 'approve_for_session' | 'reject' {
  if (decision === 'always') return 'approve_for_session';
  if (decision === 'reject') return 'reject';
  return 'approve';
}

async function waitForTurnOrStale(input: {
  turn: Turn;
  staleProgressTimeoutMs: number;
  activeToolStaleTimeoutMs: number;
  getLastMeaningfulProgressAt: () => number;
  getActiveTool: () => KimiActiveToolState | null;
}): Promise<'completed' | { status: 'stale'; message: string }> {
  const turnResult = input.turn.result
    .then((result) => {
      if (!result || typeof result !== 'object') return 'completed' as const;
      if (result.status === 'finished') return 'completed' as const;
      if (result.status === 'cancelled') return { status: 'stale' as const, message: 'kimi turn cancelled' };
      if (result.status === 'max_steps_reached') return { status: 'stale' as const, message: 'kimi max steps reached' };
      return 'completed' as const;
    })
    .catch((err) => {
      return {
        status: 'stale' as const,
        message: `kimi turn failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    });

  while (true) {
    const activeTool = input.getActiveTool();
    const timeoutMs = activeTool ? input.activeToolStaleTimeoutMs : input.staleProgressTimeoutMs;
    const lastProgressAt = activeTool ? activeTool.lastSeenAt : input.getLastMeaningfulProgressAt();
    const remaining = timeoutMs - (Date.now() - lastProgressAt);
    if (remaining <= 0) {
      return {
        status: 'stale',
        message: activeTool
          ? `kimi tool stale after ${formatDuration(timeoutMs)}: ${activeTool.message}; interrupting turn`
          : `kimi session stale after ${formatDuration(timeoutMs)}; interrupting turn`,
      };
    }
    const result = await Promise.race([
      turnResult,
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), Math.min(remaining, 1_000))),
    ]);
    if (result === 'completed') return 'completed';
    if (result && typeof result === 'object' && result.status === 'stale') return result;
  }
}

function extractKimiSessionOutput(allTurnEvents: StreamEvent[][]): {
  lines: string[];
  terminalError: string | null;
  finalMessageText: string | null;
} {
  const allLines: string[] = [];
  let terminalError: string | null = null;

  for (const turnEvents of allTurnEvents) {
    for (const event of turnEvents) {
      if (event.type === 'ContentPart') {
        const payload = event.payload as { type: string; text?: string };
        if ((payload.type === 'text' || payload.type === 'think') && payload.text) {
          allLines.push(...splitNonEmptyLines(payload.text));
        }
      }
      if (event.type === 'ToolResult') {
        const payload = event.payload as {
          tool_call_id?: string;
          return_value?: {
            is_error: boolean;
            message?: string;
            output?: string | Array<{ type: string; text?: string }>;
          };
        };
        if (payload.return_value?.is_error) {
          const rv = payload.return_value;
          const errorOutput = typeof rv.output === 'string' ? rv.output : extractTextFromContentParts(rv.output ?? []);
          const errorMsg = errorOutput || rv.message || 'unknown error';
          allLines.push(`tool failed: ${errorMsg}`);
        }
      }
      if (event.type === 'error' || event.type === 'ParseError') {
        const payload = event as unknown as {
          payload?: { message?: string; code?: string };
          message?: string;
          code?: string;
        };
        terminalError = `kimi error: ${payload.payload?.message ?? payload.message ?? payload.payload?.code ?? payload.code ?? 'unknown error'}`;
        allLines.push(terminalError);
      }
    }
  }

  const lastTurnEvents = allTurnEvents[allTurnEvents.length - 1] ?? [];
  const finalMessageText = collectText(lastTurnEvents).trim() || null;

  return {
    lines: uniqueNonEmpty(allLines),
    terminalError,
    finalMessageText,
  };
}

function isMeaningfulProgress(event: OpenCodeSessionProgressEvent): boolean {
  if (event.kind === 'permission') return true;
  if (event.message === 'kimi session busy' || event.message === 'kimi session idle') return false;
  if (event.message?.startsWith('kimi step ') && event.message?.endsWith(' started')) return false;
  return Boolean(event.message?.trim());
}

function updateActiveToolState(
  current: KimiActiveToolState | null,
  event: OpenCodeSessionProgressEvent,
  now: number,
): KimiActiveToolState | null {
  if (event.activity !== 'tool') return current;
  if (event.toolStatus === 'running') {
    return { message: event.message, lastSeenAt: now };
  }
  if (event.toolStatus === 'completed' || event.toolStatus === 'error') return null;
  return current ? { ...current, message: event.message, lastSeenAt: now } : current;
}

function messageProgress(
  message: string | null,
  sessionId: string,
  extra: Partial<OpenCodeSessionProgressEvent> = {},
): OpenCodeSessionProgressEvent | null {
  return message ? { kind: 'message', message, sessionId, ...extra } : null;
}

function lastNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function splitNonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueNonEmpty(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (!line || seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

async function settleEventTask(task: Promise<void> | undefined): Promise<void> {
  if (!task) return;
  await Promise.race([task.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 250))]);
}
