import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import * as readline from 'node:readline';
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentInvocationMode } from './agent-execution-provider.js';
import type { OpenCodeSessionExecutor, OpenCodeSessionProgressEvent } from './opencode.js';
import { buildStaleRecoveryPrompt } from './opencode.js';
import type { LaunchModel } from './types.js';

const DEFAULT_PI_MODEL: LaunchModel = { id: 'pi/default', label: 'Default' };
const DEFAULT_STALE_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_STALE_RECOVERIES = 5;

const EXECUTION_TOOL_ALLOWLIST = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

const REVIEWER_TOOL_ALLOWLIST = ['read', 'grep', 'find', 'ls'];

// PI's SDK exposes bash as an unrestricted shell tool. AFK cannot apply its
// per-command pull-request policy inside PI sessions, so PR mode uses narrow
// custom tools for the required git-push/GitHub-PR operations instead of bash.
const PULL_REQUEST_TOOL_ALLOWLIST = ['read', 'grep', 'find', 'ls', 'git_push_branch', 'gh_pr_create'];

export function resolvePiToolAllowlist(mode?: AgentInvocationMode): string[] {
  if (mode === 'reviewer') return REVIEWER_TOOL_ALLOWLIST;
  if (mode === 'pull-request') return PULL_REQUEST_TOOL_ALLOWLIST;
  return EXECUTION_TOOL_ALLOWLIST;
}

export interface PiSessionOptions {
  workingDirectory?: string;
  model?: string;
  toolAllowlist?: string[];
  customTools?: ToolDefinition[];
  title?: string;
}

interface PiSessionLike {
  readonly id: string | null;
  run(input: { prompt: string; signal?: AbortSignal }): Promise<{ events: AsyncIterable<PiEventLike> }>;
}

interface PiClientLike {
  startSession(options?: PiSessionOptions): PiSessionLike;
  resumeSession(id: string, options?: PiSessionOptions): PiSessionLike;
}

export type PiClientFactory = () => PiClientLike | Promise<PiClientLike>;

type PiEventLike = Record<string, unknown>;

interface PiActiveToolState {
  message: string;
  lastSeenAt: number;
}

export async function discoverPiModels(
  env: NodeJS.ProcessEnv = process.env,
  _repoRoot?: string,
): Promise<LaunchModel[]> {
  const configuredModels = (env.AFK_PI_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return [DEFAULT_PI_MODEL, ...configuredModels.map((model) => ({ id: `pi/${model}`, label: model }))];
}

export function parsePiModel(modelId: string): string | null {
  const prefix = 'pi/';
  if (!modelId.startsWith(prefix)) return modelId.trim() || null;
  const model = modelId.slice(prefix.length).trim();
  return model && model !== 'default' ? model : null;
}

export class PiSessionExecutor implements OpenCodeSessionExecutor {
  constructor(
    private readonly invocationMode: AgentInvocationMode = 'execution',
    private readonly factory: PiClientFactory = createDefaultPiClient,
  ) {}

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
    const options = buildPiSessionOptions(input.model, input.workDir, input.title, this.invocationMode);
    const output: string[] = [];
    let finalMessageText: string | null = null;
    let terminalError: string | null = null;
    let sessionId = input.sessionId?.trim() || null;
    let staleRecoveries = 0;
    let promptText = input.prompt;
    let lastMeaningfulProgressAt = Date.now();
    let activeTool: PiActiveToolState | null = null;
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
      const session = sessionId ? client.resumeSession(sessionId, options) : client.startSession(options);
      onProgress({
        message: sessionId ? `resuming pi session ${sessionId}` : 'starting pi session',
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
            ? `sent recovery prompt to pi (${staleRecoveries}/${maxStaleRecoveries})`
            : 'sent prompt to pi',
          sessionId,
        });

        const turnController = new AbortController();
        const abortTurn = () => turnController.abort();
        input.signal?.addEventListener('abort', abortTurn, { once: true });
        const consumeResult = await consumePiTurn({
          streamed: session.run({ prompt: promptText, signal: turnController.signal }),
          onEvent: (event) => {
            sessionId = extractSessionId(event) || sessionId;
            const text = extractAssistantMessageText(event);
            if (text) {
              output.push(text);
              finalMessageText = text;
            }
            const progress = parsePiEvent(event, sessionId);
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
        if (consumeResult.status === 'failed' || consumeResult.status === 'aborted') {
          terminalError = consumeResult.message;
          onProgress({ message: terminalError, sessionId });
          break;
        }

        staleRecoveries += 1;
        onProgress({ message: consumeResult.message, sessionId });
        if (staleRecoveries > maxStaleRecoveries) {
          terminalError = `pi session stale after ${maxStaleRecoveries} recovery attempts`;
          onProgress({ message: terminalError, sessionId });
          break;
        }
        onProgress({ message: `pi stale recovery attempt ${staleRecoveries}/${maxStaleRecoveries}`, sessionId });
        lastMeaningfulProgressAt = Date.now();
        activeTool = null;
        promptText = buildStaleRecoveryPrompt(input.prompt, staleRecoveries, maxStaleRecoveries, 'PI');
      }

      sessionId = sessionId || session.id;
      onProgress({
        message: terminalError ? `pi session failed: ${terminalError}` : 'pi session completed',
        sessionId,
      });
      return { sessionId, output, terminalError, finalMessageText };
    } catch (error) {
      const reason = input.signal?.aborted ? 'run killed' : (extractErrorMessage(error) ?? 'pi execution failed');
      return { sessionId, output, terminalError: reason, finalMessageText };
    }
  }
}

async function consumePiTurn(input: {
  streamed: Promise<{ events: AsyncIterable<PiEventLike> }>;
  onEvent: (event: PiEventLike) => void;
  onAbort: () => void;
  staleProgressTimeoutMs: number;
  activeToolStaleTimeoutMs: number;
  getLastMeaningfulProgressAt: () => number;
  getActiveTool: () => PiActiveToolState | null;
  signal?: AbortSignal;
}): Promise<
  | { status: 'completed' }
  | { status: 'failed'; message: string }
  | { status: 'stale'; message: string }
  | { status: 'aborted'; message: string }
> {
  let iterator: AsyncIterator<PiEventLike> | null = null;
  let nextPromise: Promise<IteratorResult<PiEventLike>> | null = null;
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
          ? `pi tool stale after ${formatDuration(timeoutMs)}: ${activeTool.message}; interrupting turn`
          : `pi session stale after ${formatDuration(timeoutMs)}; interrupting turn`,
      };
    }

    if (!iterator) {
      const result = await Promise.race([streamPromise, delay(Math.min(remaining, 1_000)), aborted(input.signal)]);
      if (result === 'tick') continue;
      if (result === 'aborted') {
        input.onAbort();
        return { status: 'aborted', message: 'run killed' };
      }
      iterator = result as AsyncIterator<PiEventLike>;
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

    const next = result as IteratorResult<PiEventLike>;
    if (next.done) return { status: 'completed' };
    const event = next.value;
    input.onEvent(event);
    const failure = extractTerminalFailure(event);
    if (failure) return { status: 'failed', message: failure };
    nextPromise = iterator.next();
  }
}

export function buildPiSessionOptions(
  model: LaunchModel,
  workDir?: string,
  title?: string,
  invocationMode?: AgentInvocationMode,
): PiSessionOptions {
  const options: PiSessionOptions = {
    toolAllowlist: resolvePiToolAllowlist(invocationMode),
  };
  if (invocationMode === 'pull-request') options.customTools = createPullRequestTools(workDir);
  const piModel = parsePiModel(model.id);
  if (piModel) options.model = piModel;
  if (workDir) options.workingDirectory = workDir;
  if (title) options.title = title;
  return options;
}

export function parsePiEvent(event: PiEventLike, sessionId?: string | null): OpenCodeSessionProgressEvent | null {
  const type = stringValue((event as { type?: unknown }).type)?.toLowerCase();
  if (!type) return null;

  if (type === 'session.started') {
    const id = extractSessionId(event) || sessionId || null;
    return { message: `created pi session ${id || 'unknown'}`, sessionId: id };
  }
  if (type === 'session.resumed') return { message: 'pi session resumed', sessionId };
  if (type === 'turn.started') return { message: 'pi turn started', sessionId };
  if (type === 'turn.completed') return { message: 'pi turn completed', sessionId };
  if (type === 'turn.ended') return { message: 'pi turn ended', sessionId };
  if (type === 'turn.failed' || type === 'error') {
    return { message: extractTerminalFailure(event) ?? 'pi turn failed', sessionId };
  }

  const item = recordValue((event as { item?: unknown }).item) ?? (event as Record<string, unknown>);
  const itemType = stringValue(item.type)?.toLowerCase() ?? type;

  if (itemType === 'message' || itemType === 'assistant_message') {
    const text = extractAssistantMessageText(event);
    return text ? { kind: 'message', activity: 'assistant', message: text, sessionId } : null;
  }

  if (itemType.includes('tool') || itemType.includes('command') || itemType.includes('exec')) {
    const toolName = stringValue(item.name) || stringValue(item.tool) || stringValue(item.command_type) || 'tool';
    const command = stringValue(item.command) || stringValue(item.arguments) || stringValue(item.text);
    const status = normalizeToolStatus(stringValue(item.status) ?? statusFromEventType(type));
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

function extractAssistantMessageText(event: PiEventLike): string | null {
  const item = recordValue((event as { item?: unknown }).item) ?? (event as Record<string, unknown>);
  const content = item.content ?? (event as { content?: unknown }).content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  if (typeof item.message === 'string' && item.message.trim()) return item.message.trim();
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = stringValue((part as Record<string, unknown>).text);
      if (text) texts.push(text);
    }
    return texts.join('\n') || null;
  }
  return null;
}

function extractTerminalFailure(event: PiEventLike): string | null {
  const type = stringValue((event as { type?: unknown }).type)?.toLowerCase();
  if (type !== 'turn.failed' && type !== 'error') return null;
  if (type === 'turn.failed') return extractPiError(event) ?? 'pi turn failed';
  return stringValue((event as { message?: unknown }).message) || extractPiError(event) || 'pi stream error';
}

function extractSessionId(event: PiEventLike): string | null {
  return (
    stringValue((event as { session_id?: unknown }).session_id) ||
    stringValue((event as { sessionId?: unknown }).sessionId) ||
    stringValue((event as { session?: { id?: unknown } }).session?.id)
  );
}

function extractPiError(event: PiEventLike): string | null {
  const error = (event as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  return stringValue((error as { message?: unknown }).message);
}

function isMeaningfulProgress(event: OpenCodeSessionProgressEvent): boolean {
  return Boolean(event.message.trim());
}

function updateActiveToolState(
  current: PiActiveToolState | null,
  event: OpenCodeSessionProgressEvent,
  now: number,
): PiActiveToolState | null {
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

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  if (typeof error === 'string') return error;
  return null;
}

function createPullRequestTools(cwd?: string): ToolDefinition[] {
  return [
    defineTool({
      name: 'git_push_branch',
      label: 'Git Push Branch',
      description: 'Push one named local branch to the origin remote with no force options.',
      promptSnippet: 'git_push_branch: push a local branch to origin without force options',
      parameters: Type.Object({ branch: Type.String({ minLength: 1 }) }),
      execute: async (_toolCallId, params, signal) =>
        runSafeCommand('git', ['push', 'origin', params.branch], cwd, signal),
    }),
    defineTool({
      name: 'gh_pr_create',
      label: 'GitHub PR Create',
      description: 'Create a GitHub pull request with gh pr create for a head branch and base branch.',
      promptSnippet: 'gh_pr_create: create a GitHub pull request for an already pushed branch',
      parameters: Type.Object({
        head: Type.String({ minLength: 1 }),
        base: Type.String({ minLength: 1 }),
        title: Type.String({ minLength: 1 }),
        body: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params, signal) =>
        runSafeCommand(
          'gh',
          [
            'pr',
            'create',
            '--head',
            params.head,
            '--base',
            params.base,
            '--title',
            params.title,
            '--body',
            params.body ?? '',
          ],
          cwd,
          signal,
        ),
    }),
  ];
}

async function runSafeCommand(command: string, args: string[], cwd?: string, signal?: AbortSignal) {
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null; failed: boolean }>(
    (resolve) => {
      const child = execFile(command, args, { cwd, signal }, (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code:
            typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : null,
          failed: Boolean(error),
        });
      });
      signal?.addEventListener('abort', () => child.kill(), { once: true });
    },
  );
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return {
    content: [{ type: 'text' as const, text: output || `command completed: ${command} ${args.join(' ')}` }],
    details: { command, args, exitCode: result.code },
    isError: result.failed,
  };
}

async function createDefaultPiClient(): Promise<PiClientLike> {
  return new PiSdkClient();
}

class PiSdkClient implements PiClientLike {
  startSession(options?: PiSessionOptions): PiSessionLike {
    return new PiSdkSession(options ?? {}, false);
  }

  resumeSession(id: string, options?: PiSessionOptions): PiSessionLike {
    return new PiSdkSession(options ?? {}, true, id);
  }
}

class PiSdkSession implements PiSessionLike {
  readonly id: string;

  constructor(
    private readonly options: PiSessionOptions,
    private readonly resume: boolean,
    id?: string,
  ) {
    this.id = id ?? randomUUID();
  }

  async run(input: { prompt: string; signal?: AbortSignal }): Promise<{ events: AsyncIterable<PiEventLike> }> {
    const events = this.streamEvents(input.prompt, input.signal);
    return { events };
  }

  private async *streamEvents(prompt: string, signal?: AbortSignal): AsyncGenerator<PiEventLike> {
    const cwd = this.options.workingDirectory ?? process.cwd();
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = this.options.model ? resolvePiModel(modelRegistry, this.options.model) : undefined;
    const sessionManager = this.resume
      ? await openPiSessionManager(cwd, this.id)
      : SessionManager.create(cwd, undefined, { id: this.id });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      model,
      modelRegistry,
      authStorage,
      sessionManager,
      tools: this.options.toolAllowlist,
      customTools: this.options.customTools,
      resourceLoader,
    });

    if (this.options.title) {
      try {
        session.sessionManager.appendSessionInfo(this.options.title);
      } catch {
        // ignore naming failures
      }
    }

    yield { type: 'session.started', session_id: session.sessionManager.getSessionId() };

    const queue: PiEventLike[] = [];
    let done = false;
    let runError: unknown;
    const unsubscribe = session.subscribe((event) => {
      const mapped = mapSdkEvent(event);
      if (mapped) queue.push(mapped);
    });

    const runPromise = session.prompt(prompt).then(
      () => {
        done = true;
      },
      (error: unknown) => {
        runError = error;
        done = true;
      },
    );

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          const nextEvent = queue.shift();
          if (nextEvent) yield nextEvent;
          continue;
        }
        if (signal?.aborted) {
          await session.abort();
          return;
        }
        await Promise.race([runPromise, delay(50)]);
      }

      if (runError) {
        const message = extractErrorMessage(runError) ?? 'pi execution failed';
        yield { type: 'error', message };
      }
    } finally {
      unsubscribe();
    }
  }
}

function resolvePiModel(modelRegistry: ModelRegistry, modelSpec: string) {
  const slashIndex = modelSpec.indexOf('/');
  if (slashIndex < 0) {
    throw new Error(`Invalid PI model id: ${modelSpec}`);
  }
  const provider = modelSpec.slice(0, slashIndex);
  const modelId = modelSpec.slice(slashIndex + 1);
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`PI model not found: ${modelSpec}`);
  }
  return model;
}

async function openPiSessionManager(cwd: string, sessionId: string): Promise<SessionManager> {
  const filePath = await findSessionFile(cwd, sessionId);
  if (filePath) {
    return SessionManager.open(filePath);
  }
  // If no file exists yet (e.g. process restarted before first run), start fresh with the same id.
  return SessionManager.create(cwd, undefined, { id: sessionId });
}

async function findSessionFile(cwd: string, sessionId: string): Promise<string | null> {
  const dir = getDefaultPiSessionDir(cwd);
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.endsWith(`_${sessionId}.jsonl`)) {
      return join(dir, entry);
    }
  }
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const file = join(dir, entry);
    const firstLine = await readFirstLine(file);
    if (!firstLine) continue;
    try {
      const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
      if (header.type === 'session' && header.id === sessionId) {
        return file;
      }
    } catch {
      // ignore malformed headers
    }
  }
  return null;
}

function getDefaultPiSessionDir(cwd: string): string {
  const resolved = resolvePath(cwd);
  const safePath = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(getAgentDir(), 'sessions', safePath);
}

async function readFirstLine(file: string): Promise<string | null> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      return line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

function mapSdkEvent(event: AgentSessionEvent): PiEventLike | null {
  if (typeof event !== 'object' || event === null) return null;
  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
      return { type: 'turn.started' };
    case 'turn_end':
      return { type: 'turn.ended' };
    case 'agent_end':
      return { type: 'turn.completed' };
    case 'message_end': {
      const message = (event as { message?: unknown }).message as Record<string, unknown> | undefined;
      if (!message || String(message.role) !== 'assistant') return null;
      const text = extractTextFromAgentMessage(message);
      return text ? { type: 'message', role: 'assistant', content: text } : null;
    }
    case 'tool_execution_start': {
      const e = event as { toolName?: unknown; args?: unknown };
      return {
        type: 'tool_call',
        name: String(e.toolName ?? 'tool'),
        status: 'running',
        arguments: e.args ? JSON.stringify(e.args) : '',
      };
    }
    case 'tool_execution_end': {
      const e = event as { toolName?: unknown; isError?: unknown };
      return {
        type: 'tool_call',
        name: String(e.toolName ?? 'tool'),
        status: e.isError === true ? 'failed' : 'completed',
      };
    }
    default:
      return null;
  }
}

function extractTextFromAgentMessage(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ((part as Record<string, unknown>).type === 'text') {
      const text = stringValue((part as Record<string, unknown>).text);
      if (text) texts.push(text);
    }
  }
  return texts.join('') || null;
}
