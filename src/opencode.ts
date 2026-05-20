import { createOpencode } from '@opencode-ai/sdk';
import prompts from 'prompts';
import type { LaunchModel } from './types.js';

const OPENCODE_EPHEMERAL_PORT = 0;
const DEFAULT_STALE_PROGRESS_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STALE_RECOVERIES = 3;

export type OpenCodePermissionDecision = 'once' | 'always' | 'reject';

export interface OpenCodeSessionProgressEvent {
  message: string;
  sessionId?: string | null;
  kind?: 'message' | 'permission';
  permissionId?: string | null;
  permissionPatterns?: string[];
  permissionType?: string | null;
  permissionTitle?: string | null;
}

export interface OpenCodeSessionExecutor {
  run(input: {
    model: LaunchModel;
    prompt: string;
    title: string;
    agent?: string;
    sessionId?: string | null;
    staleProgressTimeoutMs?: number;
    maxStaleRecoveries?: number;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
    decidePermission?: (request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null>;
  }): Promise<{ sessionId?: string | null; output: string[]; terminalError?: string | null }>;
}

export interface OpenCodePermissionRequest {
  sessionId: string;
  permissionId: string;
  type: string;
  title: string;
  patterns: string[];
}

export async function discoverOpenCodeModels(): Promise<LaunchModel[]> {
  const sdk = await createAfkOpencode();
  try {
    const response = await sdk.client.config.providers();
    const payload = unwrap(response);
    return extractModelsFromProvidersPayload(payload);
  } finally {
    sdk.server.close();
  }
}

export function extractModelsFromProvidersPayload(payload: unknown): LaunchModel[] {
  const providers = Array.isArray((payload as { providers?: unknown[] } | null)?.providers)
    ? ((payload as { providers: unknown[] }).providers)
    : [];
  const models: LaunchModel[] = [];
  for (const provider of providers) {
    const providerObject = provider as { id?: string; providerID?: string; models?: Record<string, unknown> | unknown[] };
    const providerId = String(providerObject.id ?? providerObject.providerID ?? '').trim();
    if (!providerId) continue;
    const entries = normalizeModelEntries(providerObject.models);
    for (const entry of entries) {
      const modelId = String(entry.id ?? entry.modelID ?? '').trim();
      if (!modelId) continue;
      const label = String(entry.name ?? '').trim() || `${providerId}/${modelId}`;
      models.push({ id: `${providerId}/${modelId}`, label });
    }
  }
  const seen = new Set<string>();
  return models.filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
}

export class SDKOpenCodeSessionExecutor implements OpenCodeSessionExecutor {
  constructor(private readonly factory: (options: { port: number }) => ReturnType<typeof createOpencode> = createOpencode) {}

  async run(input: {
    model: LaunchModel;
    prompt: string;
    title: string;
    agent?: string;
    sessionId?: string | null;
    staleProgressTimeoutMs?: number;
    maxStaleRecoveries?: number;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
    decidePermission?: (request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null>;
  }): Promise<{ sessionId?: string | null; output: string[]; terminalError?: string | null }> {
    const [providerID, modelID] = parseModelId(input.model.id);
    if (!providerID || !modelID) {
      return { sessionId: null, output: [`invalid model id: ${input.model.id}`], terminalError: `invalid model id: ${input.model.id}` };
    }
    const sdk = await createAfkOpencodeWith(this.factory);
    const abortController = new AbortController();
    let eventTask: Promise<void> | undefined;
    const terminalErrors: string[] = [];
    let lastMeaningfulProgressAt = Date.now();
    let staleRecoveries = 0;
    const staleProgressTimeoutMs = input.staleProgressTimeoutMs ?? DEFAULT_STALE_PROGRESS_TIMEOUT_MS;
    const maxStaleRecoveries = input.maxStaleRecoveries ?? DEFAULT_MAX_STALE_RECOVERIES;
    const onProgress = (event: OpenCodeSessionProgressEvent) => {
      input.onProgress?.(event);
      if (isMeaningfulProgress(event)) lastMeaningfulProgressAt = Date.now();
    };
    try {
      const sessionId = input.sessionId?.trim() || await createSession(sdk.client, input.title);
      onProgress({ message: input.sessionId ? `resuming opencode session ${sessionId || 'unknown'}` : `created opencode session ${sessionId || 'unknown'}`, sessionId: sessionId || null });
      if (sessionId) {
        eventTask = consumeSessionEvents(sdk.client, sessionId, onProgress, abortController.signal, composePermissionDecisionProvider(input.decidePermission), terminalErrors);
      }
      let promptText = input.prompt;
      while (true) {
        onProgress({ message: staleRecoveries ? `sent recovery prompt to opencode (${staleRecoveries}/${maxStaleRecoveries})` : 'sent prompt to opencode', sessionId: sessionId || null });
        const promptResult = await waitForPromptOrStale({
          prompt: sdk.client.session.prompt({
            path: { id: sessionId },
            body: buildPromptBody({ providerID, modelID, agent: input.agent, prompt: promptText }),
          }),
          staleProgressTimeoutMs,
          getLastMeaningfulProgressAt: () => lastMeaningfulProgressAt,
        });
        if (promptResult === 'completed') break;
        staleRecoveries += 1;
        onProgress({ message: `opencode session stale after ${formatDuration(staleProgressTimeoutMs)}; interrupting session`, sessionId: sessionId || null });
        await abortSession(sdk.client, sessionId, onProgress);
        if (staleRecoveries > maxStaleRecoveries) {
          const sessionOutput = sessionId ? await readSessionOutput(sdk.client, sessionId) : { lines: [], terminalError: null };
          const terminalError = `opencode session stale after ${maxStaleRecoveries} recovery attempts`;
          onProgress({ message: terminalError, sessionId: sessionId || null });
          return { sessionId: sessionId || null, output: sessionOutput.lines, terminalError };
        }
        onProgress({ message: `opencode stale recovery attempt ${staleRecoveries}/${maxStaleRecoveries}`, sessionId: sessionId || null });
        lastMeaningfulProgressAt = Date.now();
        promptText = buildStaleRecoveryPrompt(input.prompt, staleRecoveries, maxStaleRecoveries);
      }
      onProgress({ message: 'opencode prompt completed', sessionId: sessionId || null });
      const sessionOutput = sessionId ? await readSessionOutput(sdk.client, sessionId) : { lines: [], terminalError: null };
      return { sessionId: sessionId || null, output: sessionOutput.lines, terminalError: terminalErrors[0] ?? sessionOutput.terminalError ?? null };
    } finally {
      abortController.abort();
      await settleEventTask(eventTask);
      sdk.server.close();
    }
  }
}

async function createSession(client: unknown, title: string): Promise<string> {
  const sessionResponse = await (client as { session: { create: (options: unknown) => Promise<unknown> } }).session.create({ body: { title } });
  const session = unwrap(sessionResponse);
  return String(session?.id ?? '');
}

function buildPromptBody(input: { providerID: string; modelID: string; agent?: string; prompt: string }): { model: { providerID: string; modelID: string }; agent?: string; parts: Array<{ type: 'text'; text: string }> } {
  return {
    model: { providerID: input.providerID, modelID: input.modelID },
    agent: input.agent,
    parts: [{ type: 'text', text: input.prompt }],
  };
}

async function waitForPromptOrStale(input: { prompt: Promise<unknown>; staleProgressTimeoutMs: number; getLastMeaningfulProgressAt: () => number }): Promise<'completed' | 'stale'> {
  const prompt = input.prompt.then(() => 'completed' as const);
  prompt.catch(() => undefined);
  while (true) {
    const remaining = input.staleProgressTimeoutMs - (Date.now() - input.getLastMeaningfulProgressAt());
    if (remaining <= 0) return 'stale';
    const result = await Promise.race([
      prompt,
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), Math.min(remaining, 1_000))),
    ]);
    if (result === 'completed') return 'completed';
  }
}

async function abortSession(client: unknown, sessionId: string, onProgress: (event: OpenCodeSessionProgressEvent) => void): Promise<void> {
  try {
    const abort = (client as { session?: { abort?: (options: unknown) => Promise<unknown> } }).session?.abort;
    if (!abort) throw new Error('opencode session abort API is unavailable');
    await abort.call((client as { session?: unknown }).session, { path: { id: sessionId } });
    onProgress({ message: 'interrupted stale opencode session', sessionId });
  } catch (error) {
    onProgress({ message: `opencode session interrupt failed: ${error instanceof Error ? error.message : 'unknown error'}`, sessionId });
  }
}

function buildStaleRecoveryPrompt(originalPrompt: string, attempt: number, maxAttempts: number): string {
  return [
    `AFK stale-session recovery attempt ${attempt}/${maxAttempts}.`,
    '',
    'The previous turn in this same OpenCode session appeared stale and was interrupted.',
    'Continue in this same session. Use the existing transcript, current worktree state, and any completed work already present.',
    'Do not restart discovery from scratch unless the current state requires it.',
    'Continue the original AFK ticket requirements. Before exiting, update the ticket file with the final status and append/update `## AFK Summary` if complete.',
    '',
    'Original AFK prompt for reference:',
    originalPrompt,
  ].join('\n');
}

function isMeaningfulProgress(event: OpenCodeSessionProgressEvent): boolean {
  if (event.kind === 'permission') return true;
  if (event.message === 'opencode session busy' || event.message === 'opencode session idle') return false;
  return Boolean(event.message.trim());
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

async function createAfkOpencode(): ReturnType<typeof createOpencode> {
  return createAfkOpencodeWith(createOpencode);
}

export function createAfkOpencodeWith(factory: (options: { port: number }) => ReturnType<typeof createOpencode>): ReturnType<typeof createOpencode> {
  process.env.OPENCODE_PURE = 'true';
  return factory({ port: OPENCODE_EPHEMERAL_PORT });
}

function composePermissionDecisionProvider(
  override: ((request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null>) | undefined,
): (request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null> {
  if (!override) return defaultPermissionDecisionProvider;
  return async (request) => (await override(request)) ?? defaultPermissionDecisionProvider(request);
}

async function settleEventTask(task: Promise<void> | undefined): Promise<void> {
  if (!task) return;
  await Promise.race([
    task.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);
}

async function consumeSessionEvents(
  client: unknown,
  sessionId: string,
  onProgress: (event: OpenCodeSessionProgressEvent) => void,
  signal: AbortSignal,
  decidePermission: (request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null>,
  terminalErrors: string[] = [],
): Promise<void> {
  const handledPermissions = new Set<string>();
  try {
    const eventClient = (client as { event?: { subscribe?: (options?: unknown) => Promise<{ stream: AsyncIterable<unknown> }> } }).event;
    if (!eventClient?.subscribe) return;
    const subscription = await eventClient.subscribe({ signal });
    for await (const event of subscription.stream) {
      if (signal.aborted) return;
      const progress = parseOpenCodeEvent(event, sessionId);
      if (progress) onProgress(progress);
      const terminalError = parseTerminalSessionError(event, sessionId);
      if (terminalError) terminalErrors.push(terminalError);
      const permission = parsePermissionRequest(event, sessionId);
      if (!permission || handledPermissions.has(permission.permissionId)) continue;
      handledPermissions.add(permission.permissionId);
      const decision = await decidePermission(permission);
      if (!decision) continue;
      await replyToPermission(client, permission, decision);
      onProgress({
        kind: 'message',
        message: `opencode permission ${decision}: ${permission.type}${permission.patterns.length ? ` for ${permission.patterns.join(', ')}` : ''}`,
        sessionId,
        permissionId: permission.permissionId,
        permissionPatterns: permission.patterns,
      });
    }
  } catch (error) {
    if (!signal.aborted) onProgress({ message: `opencode event stream unavailable: ${error instanceof Error ? error.message : 'unknown error'}`, sessionId });
  }
}

function parseTerminalSessionError(event: unknown, sessionId: string): string | null {
  const item = unwrapSseEvent(event) as { type?: string; properties?: { sessionID?: string; error?: unknown } } | null;
  if (!item || item.type !== 'session.error' || item.properties?.sessionID !== sessionId) return null;
  return formatMessageError(item.properties.error) ?? 'opencode session error';
}

async function replyToPermission(client: unknown, request: OpenCodePermissionRequest, decision: OpenCodePermissionDecision): Promise<void> {
  const responder = (client as { postSessionIdPermissionsPermissionId?: (options: unknown) => Promise<unknown> }).postSessionIdPermissionsPermissionId;
  if (!responder) throw new Error('opencode permission response API is unavailable');
  await responder.call(client, {
    path: { id: request.sessionId, permissionID: request.permissionId },
    body: { response: decision },
  });
}

async function defaultPermissionDecisionProvider(request: OpenCodePermissionRequest): Promise<OpenCodePermissionDecision | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const pattern = request.patterns.length ? `\nPattern: ${request.patterns.join(', ')}` : '';
  const response = await prompts(
    {
      type: 'select',
      name: 'decision',
      message: `OpenCode permission required\nType: ${request.type}\nTitle: ${request.title}${pattern}`,
      choices: [
        { title: 'Allow once', value: 'once' },
        { title: 'Always allow', value: 'always' },
        { title: 'Reject', value: 'reject' },
      ],
      initial: 0,
    },
    { onCancel: () => true },
  );
  return response.decision === 'once' || response.decision === 'always' || response.decision === 'reject' ? response.decision : 'reject';
}

export function formatOpenCodeEvent(event: unknown, sessionId: string): string | null {
  return parseOpenCodeEvent(event, sessionId)?.message ?? null;
}

export function parseOpenCodeEvent(event: unknown, sessionId: string): OpenCodeSessionProgressEvent | null {
  const item = unwrapSseEvent(event) as { type?: string; properties?: { part?: unknown; info?: unknown; sessionID?: string; status?: unknown; error?: unknown; diff?: unknown[] } } | null;
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'permission.updated' || item.type === 'permission.asked') return formatPermissionRequest(item, sessionId);
  if (item.type === 'permission.replied') return formatPermissionReply(item, sessionId);
  if (item.type === 'message.part.updated') return messageProgress(formatOpenCodePart(item.properties?.part, sessionId, item.properties as { delta?: string }), sessionId);
  if (item.type === 'message.updated') {
    const info = item.properties?.info as { sessionID?: string; finish?: string } | undefined;
    if (info?.sessionID === sessionId && info.finish) return messageProgress(`assistant finished: ${info.finish}`, sessionId);
  }
  if (item.type === 'session.status' && item.properties?.sessionID === sessionId) return messageProgress(formatSessionStatus(item.properties.status), sessionId);
  if (item.type === 'session.idle' && item.properties?.sessionID === sessionId) return messageProgress('opencode session idle', sessionId);
  if (item.type === 'session.error' && item.properties?.sessionID === sessionId) return messageProgress(formatMessageError(item.properties.error) ?? 'opencode session error', sessionId);
  if (item.type === 'session.diff' && item.properties?.sessionID === sessionId) return messageProgress(formatSessionDiff(item.properties.diff), sessionId);
  return null;
}

function messageProgress(message: string | null, sessionId: string): OpenCodeSessionProgressEvent | null {
  return message ? { kind: 'message', message, sessionId } : null;
}

function formatPermissionRequest(item: { properties?: unknown }, sessionId: string): OpenCodeSessionProgressEvent {
  const permission = readPermissionProperties(item.properties);
  const permissionId = readString(permission.id) ?? readString(permission.permissionID) ?? null;
  const patterns = readStringArray(permission.patterns) ?? readStringArray(permission.pattern) ?? [];
  const permissionType = readString(permission.permission) ?? readString(permission.type) ?? 'permission';
  const permissionTitle = readString(permission.title) ?? permissionType;
  const action = readObject(permission.action);
  const actionName = readString(action?.action) ?? readString(action?.permission) ?? readString(permission.action) ?? 'decision';
  const target = patterns.length ? ` for ${patterns.join(', ')}` : '';
  const id = permissionId ? ` (${permissionId})` : '';
  return {
    kind: 'permission',
    message: `opencode permission required: ${permissionType}${target}; ${permissionTitle}; requested ${actionName}${id}`,
    sessionId,
    permissionId,
    permissionPatterns: patterns,
    permissionType,
    permissionTitle,
  };
}

function formatPermissionReply(item: { properties?: unknown }, sessionId: string): OpenCodeSessionProgressEvent | null {
  const properties = readObject(item.properties);
  if (!properties || readString(properties.sessionID) !== sessionId) return null;
  const permissionId = readString(properties.permissionID) ?? null;
  const response = readString(properties.response) ?? 'answered';
  return { kind: 'message', message: `opencode permission ${response}${permissionId ? ` (${permissionId})` : ''}`, sessionId, permissionId };
}

function parsePermissionRequest(event: unknown, sessionId: string): OpenCodePermissionRequest | null {
  const item = unwrapSseEvent(event) as { type?: string; properties?: unknown } | null;
  if (!item || (item.type !== 'permission.updated' && item.type !== 'permission.asked')) return null;
  const permission = readPermissionProperties(item.properties);
  const requestSessionId = readString(permission.sessionID) ?? sessionId;
  if (requestSessionId !== sessionId) return null;
  const permissionId = readString(permission.id) ?? readString(permission.permissionID);
  if (!permissionId) return null;
  const type = readString(permission.permission) ?? readString(permission.type) ?? 'permission';
  return {
    sessionId,
    permissionId,
    type,
    title: readString(permission.title) ?? type,
    patterns: readStringArray(permission.patterns) ?? readStringArray(permission.pattern) ?? [],
  };
}

function readPermissionProperties(value: unknown): Record<string, unknown> {
  const properties = readObject(value) ?? {};
  return readObject(properties.permission) ?? properties;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
}

function unwrapSseEvent(event: unknown): unknown {
  if (event && typeof event === 'object' && 'data' in (event as Record<string, unknown>) && !('type' in (event as Record<string, unknown>))) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function formatSessionStatus(status: unknown): string | null {
  const item = status as { type?: string; attempt?: number; message?: string } | null;
  if (!item?.type) return null;
  if (item.type === 'busy') return 'opencode session busy';
  if (item.type === 'idle') return 'opencode session idle';
  if (item.type === 'retry') return `opencode retry${item.attempt ? ` ${item.attempt}` : ''}${item.message ? `: ${item.message}` : ''}`;
  return `opencode session ${item.type}`;
}

function formatSessionDiff(diff: unknown[] | undefined): string | null {
  if (!Array.isArray(diff) || !diff.length) return null;
  return `updated diff: ${diff.length} file${diff.length === 1 ? '' : 's'}`;
}

function formatOpenCodePart(part: unknown, sessionId: string, eventProperties?: { delta?: string }): string | null {
  const item = part as { sessionID?: string; type?: string; text?: string; tool?: string; state?: unknown } | null;
  if (!item || item.sessionID !== sessionId) return null;
  if ((item.type === 'text' || item.type === 'reasoning') && (eventProperties?.delta || item.text)) {
    const text = lastNonEmptyLine(eventProperties?.delta ?? item.text ?? '');
    return text ? `${item.type}: ${text}` : null;
  }
  if (item.type === 'tool') return formatToolPart(item.tool, item.state);
  if (item.type === 'patch') return 'updated patch';
  return item.type ? `updated ${item.type}` : null;
}

function formatToolPart(tool: string | undefined, state: unknown): string | null {
  const value = state as { status?: string; title?: string; error?: string } | null;
  const name = tool ? `tool ${tool}` : 'tool';
  if (!value?.status) return `updated ${name}`;
  if (value.status === 'running') return `${name} running${value.title ? `: ${value.title}` : ''}`;
  if (value.status === 'completed') return `${name} completed${value.title ? `: ${value.title}` : ''}`;
  if (value.status === 'error') return `${name} failed${value.error ? `: ${value.error}` : ''}`;
  return `${name} ${value.status}`;
}

function lastNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

function parseModelId(value: string): [string, string] {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return ['', ''];
  return [trimmed.slice(0, slash), trimmed.slice(slash + 1)];
}

function normalizeModelEntries(models: Record<string, unknown> | unknown[] | undefined): Array<{ id?: string; modelID?: string; name?: string }> {
  if (Array.isArray(models)) {
    return models as Array<{ id?: string; modelID?: string; name?: string }>;
  }
  if (!models || typeof models !== 'object') return [];
  const output: Array<{ id?: string; modelID?: string; name?: string }> = [];
  for (const [key, value] of Object.entries(models)) {
    if (!value || typeof value !== 'object') {
      output.push({ id: key });
      continue;
    }
    const model = value as { id?: string; modelID?: string; name?: string };
    output.push({ id: model.id ?? key, modelID: model.modelID, name: model.name });
  }
  return output;
}

async function readSessionOutput(client: unknown, sessionId: string): Promise<{ lines: string[]; terminalError: string | null }> {
  const sessionClient = (client as { session?: { messages?: (options?: unknown) => Promise<unknown> } }).session;
  if (!sessionClient?.messages) return { lines: [], terminalError: null };
  const response = await callSessionMessages(sessionClient.messages.bind(sessionClient), sessionId);
  return extractSessionOutput(unwrap(response));
}

async function callSessionMessages(messages: (options?: unknown) => Promise<unknown>, sessionId: string): Promise<unknown> {
  try {
    return await messages({ path: { id: sessionId } });
  } catch (_error) {
    return messages({ sessionID: sessionId });
  }
}

export function extractSessionOutputLines(payload: unknown): string[] {
  return extractSessionOutput(payload).lines;
}

export function extractSessionOutput(payload: unknown): { lines: string[]; terminalError: string | null } {
  const messages = normalizeSessionMessages(payload);
  const lines: string[] = [];
  const terminalErrors: string[] = [];
  for (const message of messages) {
    const item = message as { info?: unknown; parts?: unknown[]; text?: string; content?: string; message?: string; output?: string } | null;
    const error = formatMessageError((item?.info as { error?: unknown } | undefined)?.error);
    if (error) {
      lines.push(error);
      terminalErrors.push(error);
    }
    for (const part of Array.isArray(item?.parts) ? item.parts : []) {
      const partLines = formatSessionPart(part);
      lines.push(...partLines);
    }
    for (const value of [item?.text, item?.content, item?.message, item?.output]) {
      if (typeof value === 'string') lines.push(...splitNonEmptyLines(value));
    }
  }
  return { lines: uniqueNonEmpty(lines), terminalError: terminalErrors[0] ?? null };
}

function normalizeSessionMessages(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const objectPayload = readObject(payload);
  if (!objectPayload) return [];

  if (Array.isArray(objectPayload.messages)) return objectPayload.messages;
  if (Array.isArray(objectPayload.items)) return objectPayload.items;

  const nestedData = readObject(objectPayload.data);
  if (!nestedData) return [];
  if (Array.isArray(nestedData.messages)) return nestedData.messages;
  if (Array.isArray(nestedData.items)) return nestedData.items;
  return [];
}

function formatMessageError(error: unknown): string | null {
  if (typeof error === 'string' && error.trim()) return `opencode error: ${error.trim()}`;
  const item = error as { name?: string; data?: { message?: string; responseBody?: string } } | null;
  if (!item || typeof item !== 'object') return null;
  const message = String(item.data?.message ?? item.data?.responseBody ?? '').trim();
  if (!message) return item.name ? `opencode error: ${item.name}` : null;
  return `opencode error: ${message}`;
}

function formatSessionPart(part: unknown): string[] {
  const item = part as { type?: string; text?: string; content?: string; message?: string; output?: string; state?: { status?: string; error?: string; output?: string } } | null;
  if (!item || typeof item !== 'object') return [];
  if ((item.type === 'text' || item.type === 'reasoning') && item.text) return splitNonEmptyLines(item.text);
  if ((item.type === 'text' || item.type === 'reasoning') && item.content) return splitNonEmptyLines(item.content);
  if (item.type === 'text' && item.message) return splitNonEmptyLines(item.message);
  if (item.type === 'text' && item.output) return splitNonEmptyLines(item.output);
  if (item.type === 'tool' && item.state?.status === 'error' && item.state.error) return [`tool failed: ${item.state.error}`];
  return [];
}

function splitNonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function uniqueNonEmpty(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => line && (seen.has(line) ? false : (seen.add(line), true)));
}

function unwrap<T>(value: T): any {
  if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
    return (value as unknown as { data: unknown }).data;
  }
  return value;
}
