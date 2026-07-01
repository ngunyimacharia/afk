import path from 'node:path';
import {
  claudeCode,
  codex,
  createSandbox,
  opencode,
  type Sandbox,
  type SandboxProvider,
  type AgentProvider as SandcastleAgentProvider,
} from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { providerNameForHarness, type SelectableHarnessId } from './harness-registry.js';
import type { RuntimeRecordHandle, RuntimeStore } from './runtime-store.js';
import type {
  AgentExecutionProgressCallback,
  AgentExecutionResult,
  LaunchPlan,
  SandcastleSandboxMode,
  TicketRecord,
} from './types.js';

export interface SandcastleImplementationInput {
  plan: LaunchPlan;
  ticket: TicketRecord;
  prompt: string;
  record: RuntimeRecordHandle;
  signal?: AbortSignal;
  onProgress?: AgentExecutionProgressCallback;
}

export interface SandcastleFactories {
  createSandbox?: typeof createSandbox;
  createDockerProvider?: typeof docker;
  createNoSandboxProvider?: typeof noSandbox;
  createAgentProvider?: (harness: SelectableHarnessId, modelId: string) => SandcastleAgentProvider;
}

export class SandcastleImplementationCore {
  private readonly createSandboxFn: typeof createSandbox;
  private readonly createDockerProvider: typeof docker;
  private readonly createNoSandboxProvider: typeof noSandbox;
  private readonly createAgentProviderFn: (harness: SelectableHarnessId, modelId: string) => SandcastleAgentProvider;

  constructor(
    private readonly runtimeStore: RuntimeStore,
    private readonly sandboxMode: SandcastleSandboxMode,
    factories: SandcastleFactories = {},
  ) {
    this.createSandboxFn = factories.createSandbox ?? createSandbox;
    this.createDockerProvider = factories.createDockerProvider ?? docker;
    this.createNoSandboxProvider = factories.createNoSandboxProvider ?? noSandbox;
    this.createAgentProviderFn = factories.createAgentProvider ?? createSandcastleAgentProvider;
  }

  async execute(input: SandcastleImplementationInput): Promise<AgentExecutionResult> {
    const harness = input.plan.harness ?? 'OpenCode';
    const providerName = providerNameForHarness(harness);
    const branch = input.plan.checkout.effectiveBranchName;
    const sandcastleLogPath = sandcastleLogPathFor(input.record.logPath);
    const sandboxProvider = this.createSandboxProvider();
    const agent = this.createAgentProviderFn(harness, input.plan.model.id);

    this.runtimeStore.updateMetadata(input.record.metadataPath, {
      EXECUTION_PROVIDER: providerName,
      EXECUTION_MODEL_ID: input.plan.model.id,
      SANDCASTLE_SANDBOX_MODE: this.sandboxMode,
      SANDCASTLE_BRANCH: branch,
      SANDCASTLE_PROVIDER: providerName,
      SANDCASTLE_LOG_PATH: sandcastleLogPath,
      SANDCASTLE_COMMITS: [],
    });
    this.runtimeStore.appendLog(
      input.record.logPath,
      `sandcastle implementation start: mode=${this.sandboxMode} provider=${providerName} branch=${branch}`,
    );
    input.onProgress?.({
      ticketLabel: input.ticket.label,
      message: `sandcastle ${this.sandboxMode} execution starting`,
    });

    let sandbox: Sandbox | null = null;
    try {
      sandbox = await this.createSandboxFn({
        cwd: input.plan.repoRoot,
        branch,
        sandbox: sandboxProvider,
      });
      this.runtimeStore.updateMetadata(input.record.metadataPath, {
        SANDCASTLE_WORKTREE_PATH: sandbox.worktreePath,
        SANDCASTLE_BRANCH: sandbox.branch,
      });

      const result = await sandbox.run({
        agent,
        prompt: input.prompt,
        maxIterations: 1,
        name: `afk-${input.ticket.feature}-${input.ticket.issueName}-implementation`,
        logging: { type: 'file', path: sandcastleLogPath, verbose: true },
        signal: input.signal,
      });
      const commits = result.commits.map((commit) => commit.sha);
      this.runtimeStore.updateMetadata(input.record.metadataPath, {
        SANDCASTLE_LOG_PATH: result.logFilePath ?? sandcastleLogPath,
        SANDCASTLE_COMMITS: commits,
        SANDCASTLE_PHASE_RESULT: {
          phase: 'implementation',
          status: 'completed',
          stdout: truncate(result.stdout),
        },
      });
      this.runtimeStore.appendLog(input.record.logPath, `sandcastle commits: ${commits.join(', ') || '(none)'}`);
      input.onProgress?.({ ticketLabel: input.ticket.label, message: 'sandcastle implementation completed' });
      return { status: 'completed', output: result.stdout ? [result.stdout] : [] };
    } catch (error) {
      const message = errorToString(error);
      const commits = commitsFromError(error);
      this.runtimeStore.updateMetadata(input.record.metadataPath, {
        SANDCASTLE_WORKTREE_PATH: sandbox?.worktreePath,
        SANDCASTLE_BRANCH: sandbox?.branch ?? branch,
        SANDCASTLE_COMMITS: commits,
        SANDCASTLE_PHASE_RESULT: {
          phase: 'implementation',
          status: input.signal?.aborted ? 'interrupted' : 'failed',
          error: truncate(message),
        },
        PROVIDER_FAILURE_SOURCE: 'agent-thrown',
        PROVIDER_FAILURE_EVIDENCE: truncate(message),
      });
      this.runtimeStore.appendLog(input.record.logPath, `sandcastle implementation failed: ${message}`);
      input.onProgress?.({
        ticketLabel: input.ticket.label,
        message: 'sandcastle implementation failed',
        kind: 'failure',
      });
      return { status: input.signal?.aborted ? 'interrupted' : 'failed', unsafeReason: message, output: [message] };
    } finally {
      await sandbox?.close();
    }
  }

  private createSandboxProvider(): SandboxProvider {
    if (this.sandboxMode === 'docker') return this.createDockerProvider();
    return this.createNoSandboxProvider() as SandboxProvider;
  }
}

export function resolveSandcastleSandboxMode(
  env: NodeJS.ProcessEnv,
  preferred?: SandcastleSandboxMode,
): SandcastleSandboxMode {
  const envMode = env.AFK_SANDBOX_MODE ?? env.AFK_SANDCASTLE_SANDBOX_MODE;
  if (envMode === 'docker' || envMode === 'no-sandbox') return envMode;
  return preferred ?? 'no-sandbox';
}

function createSandcastleAgentProvider(harness: SelectableHarnessId, modelId: string): SandcastleAgentProvider {
  if (harness === 'Claude') return claudeCode(modelId);
  if (harness === 'Codex') return codex(modelId);
  return opencode(modelId);
}

function sandcastleLogPathFor(runtimeLogPath: string): string {
  const parsed = path.parse(runtimeLogPath);
  return path.join(parsed.dir, `${parsed.name}.sandcastle.log`);
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function commitsFromError(error: unknown): string[] {
  if (!error || typeof error !== 'object' || !('commits' in error)) return [];
  const commits = (error as { commits?: unknown }).commits;
  if (!Array.isArray(commits)) return [];
  return commits.flatMap((commit) => {
    if (commit && typeof commit === 'object' && typeof (commit as { sha?: unknown }).sha === 'string') {
      return [(commit as { sha: string }).sha];
    }
    return [];
  });
}

function truncate(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}
