import {
  type AgentProvider,
  type CloseResult,
  createSandbox,
  type ExecResult,
  type Sandbox,
  type SandboxRunResult,
} from '@ai-hero/sandcastle';
import { type DockerOptions, docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { parsePiEvent } from './pi.js';
import type { SandcastleAgentProviderSelection } from './sandcastle-provider.js';

type SandcastleStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'session_id'; sessionId: string };

export interface AfkSandcastleMount {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}

export interface AfkSandcastleDockerRuntimeInput {
  repoRoot: string;
  branch: string;
  baseBranch?: string;
  imageName?: string;
  mounts?: AfkSandcastleMount[];
  env?: Record<string, string>;
}

export interface AfkSandcastleRunPhaseInput {
  phase: string;
  agent: AgentProvider;
  prompt: string;
  maxIterations?: number;
  signal?: AbortSignal;
}

export interface AfkSandcastlePhaseResult {
  phase: string;
  stdout: string;
  commits: { sha: string }[];
  sessionId?: string;
  logFilePath?: string;
}

export interface AfkSandcastleContainerIdentity {
  kind: 'docker-container';
  id: string;
  source: 'hostname';
}

export interface AfkSandcastleRuntimeAdapter {
  readonly branch: string;
  readonly worktreePath: string;
  runPhase(input: AfkSandcastleRunPhaseInput): Promise<AfkSandcastlePhaseResult>;
  identifyContainer(): Promise<AfkSandcastleContainerIdentity>;
  cleanup(): Promise<CloseResult>;
}

export interface AfkSandcastleRuntimeBlocked {
  status: 'blocked';
  reason: string;
  missingCapability: AfkSandcastlePackageCapability;
}

export type AfkSandcastleRuntimeCreateResult =
  | { status: 'available'; adapter: AfkSandcastleRuntimeAdapter }
  | AfkSandcastleRuntimeBlocked;

export type AfkSandcastlePackageCapability =
  | 'docker-provider'
  | 'create-sandbox'
  | 'warm-run'
  | 'exec'
  | 'identity'
  | 'cleanup';

export interface AfkSandcastleCapabilityCheckInput extends AfkSandcastleDockerRuntimeInput {
  agent: AgentProvider;
  prompts?: string[];
}

export interface AfkSandcastleCapabilityAvailable {
  status: 'available';
  identity: AfkSandcastleContainerIdentity;
  phaseCount: number;
}

export type AfkSandcastleCapabilityCheckResult = AfkSandcastleCapabilityAvailable | AfkSandcastleRuntimeBlocked;

interface SandcastlePackageFacade {
  createSandbox?: typeof createSandbox;
  docker?: typeof docker;
}

const sandcastlePackage: SandcastlePackageFacade = { createSandbox, docker };

export function createAfkSandcastleAgentProvider(selection: SandcastleAgentProviderSelection): AgentProvider {
  if (selection.provider === 'pi') return createPiSandcastleAgentProvider(selection);
  return {
    name: selection.provider,
    env: {},
    captureSessions: true,
    buildPrintCommand: (options) => ({
      command: [selection.provider, ...(selection.model ? ['--model', selection.model] : [])].join(' '),
      stdin: options.prompt,
    }),
    parseStreamLine: () => [],
  };
}

function createPiSandcastleAgentProvider(selection: SandcastleAgentProviderSelection): AgentProvider {
  const model = selection.model ? selection.model.replace(/^pi\//, '') : undefined;
  return {
    name: 'pi',
    env: {},
    captureSessions: true,
    buildPrintCommand: (options) => ({
      command: ['pi', ...(model ? ['--model', model] : []), '--print', '--mode', 'json'].join(' '),
      stdin: options.prompt,
    }),
    parseStreamLine: (line: string) => {
      try {
        const parsed = JSON.parse(line);
        const text = extractPiAssistantText(parsed);
        if (text) return [{ type: 'text' as const, text }];
        const event = parsePiEvent(parsed);
        return event ? toSandcastleStreamEvents(event) : [];
      } catch {
        return line.trim() ? [{ type: 'text' as const, text: line.trim() }] : [];
      }
    },
  };
}

function extractPiAssistantText(parsed: Record<string, unknown>): string | null {
  const type = String(parsed.type ?? '').toLowerCase();
  // PI assistant messages contain the model's text response
  if (type === 'message' || type === 'assistant_message' || type === 'user_message') {
    const content = (parsed as { content?: Array<{ type?: string; text?: string }> }).content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c): c is { type: string; text: string } => typeof c?.text === 'string')
        .map((c) => c.text);
      if (parts.length) return parts.join('\n');
    }
    const text = (parsed as { text?: string }).text;
    if (typeof text === 'string') return text;
  }
  // PI tool call items contain command output — skip these for reviewer clarity
  const item = (parsed as { item?: { type?: string } }).item;
  if (item?.type === 'tool_call' || item?.type === 'tool_result') return null;
  return null;
}

function toSandcastleStreamEvents(event: {
  message: string;
  sessionId?: string | null;
  activity?: string | null;
  toolName?: string | null;
}): SandcastleStreamEvent[] {
  const events: SandcastleStreamEvent[] = [];
  if (event.sessionId) events.push({ type: 'session_id', sessionId: event.sessionId });
  if (event.activity === 'tool' && event.toolName) {
    events.push({ type: 'tool_call', name: event.toolName, args: event.message });
  } else if (event.message) {
    events.push({ type: 'text', text: event.message });
  }
  return events;
}

export async function createAfkSandcastleDockerRuntime(
  input: AfkSandcastleDockerRuntimeInput,
  facade: SandcastlePackageFacade = sandcastlePackage,
): Promise<AfkSandcastleRuntimeCreateResult> {
  if (!facade.docker) return blocked('docker-provider', '@ai-hero/sandcastle does not export a Docker provider');
  if (!facade.createSandbox) return blocked('create-sandbox', '@ai-hero/sandcastle does not export createSandbox');

  const sandboxProvider = facade.docker(toDockerOptions(input));
  const sandbox = await facade.createSandbox({
    branch: input.branch,
    baseBranch: input.baseBranch,
    cwd: input.repoRoot,
    sandbox: sandboxProvider,
  });
  const validation = validateSandboxHandle(sandbox);
  if (validation) return validation;

  return { status: 'available', adapter: new SandcastleDockerRuntimeAdapter(sandbox) };
}

export async function checkAfkSandcastleWarmDockerRuntimeCapability(
  input: AfkSandcastleCapabilityCheckInput,
  facade: SandcastlePackageFacade = sandcastlePackage,
): Promise<AfkSandcastleCapabilityCheckResult> {
  const runtime = await createAfkSandcastleDockerRuntime(input, facade);
  if (runtime.status === 'blocked') return runtime;

  let identity: AfkSandcastleContainerIdentity;
  try {
    identity = await runtime.adapter.identifyContainer();
  } catch (error) {
    await runtime.adapter.cleanup();
    return blocked('identity', error instanceof Error ? error.message : 'Sandcastle Docker identity probe failed');
  }

  try {
    const prompts = input.prompts ?? [
      'AFK Sandcastle package warm runtime smoke phase 1',
      'AFK Sandcastle package warm runtime smoke phase 2',
    ];
    for (const [index, prompt] of prompts.entries()) {
      await runtime.adapter.runPhase({
        phase: `capability-${index + 1}`,
        agent: input.agent,
        prompt,
        maxIterations: 1,
      });
    }
    return { status: 'available', identity, phaseCount: prompts.length };
  } catch (error) {
    return blocked(
      'warm-run',
      error instanceof Error ? error.message : 'Sandcastle warm runtime capability check failed',
    );
  } finally {
    await runtime.adapter.cleanup();
  }
}

function toDockerOptions(input: AfkSandcastleDockerRuntimeInput): DockerOptions {
  return {
    imageName: input.imageName,
    mounts: input.mounts,
    env: input.env,
  };
}

function validateSandboxHandle(sandbox: Sandbox): AfkSandcastleRuntimeBlocked | null {
  if (typeof sandbox.run !== 'function') {
    return blocked('warm-run', '@ai-hero/sandcastle sandbox handle cannot run repeated phases');
  }
  if (typeof sandbox.exec !== 'function') {
    return blocked('exec', '@ai-hero/sandcastle sandbox handle cannot execute identity probes');
  }
  if (typeof sandbox.close !== 'function') {
    return blocked('cleanup', '@ai-hero/sandcastle sandbox handle cannot clean up runtime resources');
  }
  return null;
}

function blocked(missingCapability: AfkSandcastlePackageCapability, reason: string): AfkSandcastleRuntimeBlocked {
  return { status: 'blocked', missingCapability, reason };
}

class SandcastleDockerRuntimeAdapter implements AfkSandcastleRuntimeAdapter {
  constructor(private readonly sandbox: Sandbox) {}

  get branch(): string {
    return this.sandbox.branch;
  }

  get worktreePath(): string {
    return this.sandbox.worktreePath;
  }

  async runPhase(input: AfkSandcastleRunPhaseInput): Promise<AfkSandcastlePhaseResult> {
    const result: SandboxRunResult = await this.sandbox.run({
      agent: input.agent,
      prompt: input.prompt,
      maxIterations: input.maxIterations,
      signal: input.signal,
      name: input.phase,
    });

    return {
      phase: input.phase,
      stdout: result.stdout,
      commits: result.commits,
      sessionId: result.iterations.at(-1)?.sessionId,
      logFilePath: result.logFilePath,
    };
  }

  async identifyContainer(): Promise<AfkSandcastleContainerIdentity> {
    const result: ExecResult = await this.sandbox.exec("sh -c 'hostname 2>/dev/null || cat /etc/hostname 2>/dev/null'");
    const id = result.stdout.trim().split(/\r?\n/).find(Boolean);
    if (result.exitCode !== 0 || !id) {
      throw new Error(`Sandcastle Docker identity probe failed with exit code ${result.exitCode}`);
    }

    return { kind: 'docker-container', id, source: 'hostname' };
  }

  cleanup(): Promise<CloseResult> {
    return this.sandbox.close();
  }
}
