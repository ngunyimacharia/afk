import { createOpencode } from '@opencode-ai/sdk';
import type { LaunchModel } from './types.js';

export interface OpenCodeSessionProgressEvent {
  message: string;
  sessionId?: string | null;
}

export interface OpenCodeSessionExecutor {
  run(input: {
    model: LaunchModel;
    prompt: string;
    title: string;
    agent?: string;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
  }): Promise<{ sessionId?: string | null; output: string[] }>;
}

export async function discoverOpenCodeModels(): Promise<LaunchModel[]> {
  const sdk = await createOpencode();
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
  async run(input: {
    model: LaunchModel;
    prompt: string;
    title: string;
    agent?: string;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
  }): Promise<{ sessionId?: string | null; output: string[] }> {
    const [providerID, modelID] = parseModelId(input.model.id);
    if (!providerID || !modelID) {
      return { sessionId: null, output: [`invalid model id: ${input.model.id}`] };
    }
    const sdk = await createOpencode();
    const abortController = new AbortController();
    let eventTask: Promise<void> | undefined;
    try {
      const sessionResponse = await sdk.client.session.create({ body: { title: input.title } });
      const session = unwrap(sessionResponse);
      const sessionId = String(session?.id ?? '');
      input.onProgress?.({ message: `created opencode session ${sessionId || 'unknown'}`, sessionId: sessionId || null });
      if (sessionId && input.onProgress) {
        eventTask = consumeSessionEvents(sdk.client, sessionId, input.onProgress, abortController.signal);
      }
      input.onProgress?.({ message: 'sent prompt to opencode', sessionId: sessionId || null });
      await sdk.client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          agent: input.agent,
          parts: [{ type: 'text', text: input.prompt }],
        },
      });
      input.onProgress?.({ message: 'opencode prompt completed', sessionId: sessionId || null });
      const output = sessionId ? await readSessionOutput(sdk.client, sessionId) : [];
      return { sessionId: sessionId || null, output: output.length ? output : ['opencode session prompt completed'] };
    } finally {
      abortController.abort();
      await settleEventTask(eventTask);
      sdk.server.close();
    }
  }
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
): Promise<void> {
  try {
    const eventClient = (client as { event?: { subscribe?: (options?: unknown) => Promise<{ stream: AsyncIterable<unknown> }> } }).event;
    if (!eventClient?.subscribe) return;
    const subscription = await eventClient.subscribe({ signal });
    for await (const event of subscription.stream) {
      if (signal.aborted) return;
      const message = formatOpenCodeEvent(event, sessionId);
      if (message) onProgress({ message, sessionId });
    }
  } catch (error) {
    if (!signal.aborted) onProgress({ message: `opencode event stream unavailable: ${error instanceof Error ? error.message : 'unknown error'}`, sessionId });
  }
}

export function formatOpenCodeEvent(event: unknown, sessionId: string): string | null {
  const item = unwrapSseEvent(event) as { type?: string; properties?: { part?: unknown; info?: unknown; sessionID?: string; status?: unknown; error?: unknown; diff?: unknown[] } } | null;
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'message.part.updated') return formatOpenCodePart(item.properties?.part, sessionId, item.properties as { delta?: string });
  if (item.type === 'message.updated') {
    const info = item.properties?.info as { sessionID?: string; finish?: string } | undefined;
    if (info?.sessionID === sessionId && info.finish) return `assistant finished: ${info.finish}`;
  }
  if (item.type === 'session.status' && item.properties?.sessionID === sessionId) return formatSessionStatus(item.properties.status);
  if (item.type === 'session.idle' && item.properties?.sessionID === sessionId) return 'opencode session idle';
  if (item.type === 'session.error' && item.properties?.sessionID === sessionId) return formatMessageError(item.properties.error) ?? 'opencode session error';
  if (item.type === 'session.diff' && item.properties?.sessionID === sessionId) return formatSessionDiff(item.properties.diff);
  return null;
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

async function readSessionOutput(client: unknown, sessionId: string): Promise<string[]> {
  const sessionClient = (client as { session?: { messages?: (options?: unknown) => Promise<unknown> } }).session;
  if (!sessionClient?.messages) return [];
  const response = await callSessionMessages(sessionClient.messages.bind(sessionClient), sessionId);
  return extractSessionOutputLines(unwrap(response));
}

async function callSessionMessages(messages: (options?: unknown) => Promise<unknown>, sessionId: string): Promise<unknown> {
  try {
    return await messages({ path: { id: sessionId } });
  } catch (_error) {
    return messages({ sessionID: sessionId });
  }
}

export function extractSessionOutputLines(payload: unknown): string[] {
  const messages = Array.isArray(payload) ? payload : [];
  const lines: string[] = [];
  for (const message of messages) {
    const item = message as { info?: unknown; parts?: unknown[] } | null;
    const error = formatMessageError((item?.info as { error?: unknown } | undefined)?.error);
    if (error) lines.push(error);
    for (const part of Array.isArray(item?.parts) ? item.parts : []) {
      const partLines = formatSessionPart(part);
      lines.push(...partLines);
    }
  }
  return uniqueNonEmpty(lines);
}

function formatMessageError(error: unknown): string | null {
  const item = error as { name?: string; data?: { message?: string; responseBody?: string } } | null;
  if (!item || typeof item !== 'object') return null;
  const message = String(item.data?.message ?? item.data?.responseBody ?? '').trim();
  if (!message) return item.name ? `opencode error: ${item.name}` : null;
  return `opencode error: ${message}`;
}

function formatSessionPart(part: unknown): string[] {
  const item = part as { type?: string; text?: string; state?: { status?: string; error?: string; output?: string } } | null;
  if (!item || typeof item !== 'object') return [];
  if ((item.type === 'text' || item.type === 'reasoning') && item.text) return splitNonEmptyLines(item.text);
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
