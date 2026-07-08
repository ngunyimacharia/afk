import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AgentExecutionProvider, AgentExecutionRequest } from './agent-execution-provider.js';
import { providerNameForHarness } from './harness-registry.js';
import type { LinearRunSyncClient, ResolvedLinearConfig } from './linear.js';
import { syncLinearRunStarted, syncLinearRunTerminal } from './linear.js';
import { validateSelectedTicketPath } from './path-validation.js';
import { buildPrompt } from './prompt-builder.js';
import { classifyProviderFailureFromSource, isDeterministicFailureKind } from './provider-failure.js';
import type { ReadinessCommandExecutor } from './readiness-service.js';
import { SyncReadinessCommandExecutor } from './readiness-service.js';
import { decideReviewOutcome, parseReviewerOutput } from './reviewer-output-contract.js';
import type { RuntimeRecordHandle, RuntimeStore } from './runtime-store.js';
import {
  type DockerContainerIdentity,
  dockerCleanupCommand,
  dockerContainerResourceId,
  getDefaultSandcastleDockerCleanup,
  toCleanupResult,
} from './sandcastle-cleanup.js';
import type { SandcastleAgentProviderSelection } from './sandcastle-provider.js';
import {
  AFK_RUNTIME_IMAGE,
  AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY,
  AFK_RUNTIME_PROVIDER_CONFIG_TARGETS,
  AFK_RUNTIME_WORKTREE_PATH,
  DockerSandcastleRuntimeImageClient,
  type SandcastleRuntimeImageValidationResult,
  validateSandcastleRuntimeImage,
} from './sandcastle-runtime-image-contract.js';
import { type SandcastlePhaseName, SandcastleRuntimeStore } from './sandcastle-runtime-store.js';
import type {
  AfkStateSnapshot,
  AgentExecutionProgressCallback,
  AgentExecutionProgressEvent,
  AgentExecutionResult,
  BudgetExceededEvent,
  BudgetPhaseName,
  BudgetPolicy,
  LaunchBlockEvidence,
  LaunchPlan,
  ReviewCycleHistoryEntry,
  ReviewerPromptTemplate,
  ReviewOutcomeClassification,
  ReviewTerminalOutcomeRecord,
  TicketRecord,
} from './types.js';
import { runGit } from './worktree-preparation-service.js';

const FIXUP_REMEDIATION_GUIDANCE =
  'Remediation instructions: create one or more additional conventional fixup commits for the reviewer findings before the next review pass.';
const REVIEWER_OUTPUT_MALFORMED_FAILURE_KIND = 'reviewer-output-malformed';
const REVIEWER_EMPTY_OUTPUT_FAILURE_KIND = 'reviewer-empty-output';
const LAUNCHER_CONTEXT_MISMATCH_FAILURE_KIND = 'launcher-context-mismatch';
const TICKET_READ_FAILURE_KIND = 'ticket-read-failure';
const REVIEW_TARGET_MISMATCH_FAILURE_KIND = 'review-target-mismatch';

const REVIEWER_FORMAT_REPAIR_INSTRUCTIONS = [
  'The previous reviewer response was malformed and could not be parsed.',
  'Return EXACTLY ONE LINE of raw JSON. No markdown fences. No line breaks inside the JSON.',
  'Valid example: {"summary":"One regression found","findings":[{"severity":"major","title":"Pagination bug","detail":"Job dispatches without page parameter."}]}',
].join(' ');
const REVIEWER_EMPTY_REPAIR_INSTRUCTIONS = [
  'The previous reviewer response was empty.',
  'You must still return EXACTLY ONE LINE of raw JSON with the required reviewer object.',
  'Updating the ticket, committing changes, or completing finalization actions does not remove the requirement to return JSON.',
  'No markdown fences. No prose. No line breaks inside the JSON.',
].join(' ');
const MAX_MALFORMED_OUTPUT_SNIPPET_CHARS = 500;
const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  malformedReviewerRetries: 2,
  fixupCycleLimit: 50,
  providerFailureRetries: 10,
  deterministicProviderFailureRetries: 2,
  ticketWallClockMs: 60 * 60 * 1000,
  phaseWallClockMs: {
    execution: 30 * 60 * 1000,
    review: 10 * 60 * 1000,
    fixup: 10 * 60 * 1000,
  },
};

export interface SingleTicketRunResult {
  scheduled: boolean;
  message: string;
  outcome?: 'completed' | 'blocked' | 'failed' | 'not-scheduled' | 'handoff';
  launchBlock?: LaunchBlockEvidence;
}

export interface SingleTicketLaunchOptions {
  onProgress?: AgentExecutionProgressCallback;
  runId?: string;
  signal?: AbortSignal;
}

export interface LinearRunSyncer {
  resolvedConfig: ResolvedLinearConfig;
  client: LinearRunSyncClient;
}

export interface WarmSandcastleSandboxHandle {
  readonly containerIdentity?: { containerName?: string; containerId?: string };
  readonly worktreePath?: string;
  run(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  identifyContainer?(): Promise<DockerContainerIdentity>;
  cleanup?(): Promise<{ status?: string; message?: string } | undefined>;
}

export interface WarmSandcastleSandboxFactory {
  validateRuntimeImage?(plan: LaunchPlan): Promise<SandcastleRuntimeImageValidationResult>;
  create(plan: LaunchPlan): Promise<WarmSandcastleSandboxHandle>;
}

class ProviderBackedWarmSandcastleSandbox implements WarmSandcastleSandboxHandle {
  constructor(private readonly provider: AgentExecutionProvider) {}

  run(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.provider.execute(request);
  }
}

interface PackageRuntimeAdapter {
  readonly worktreePath: string;
  identifyContainer(): Promise<{ id: string }>;
  runPhase(input: {
    phase: string;
    agent: unknown;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; sessionId?: string }>;
}

class PackageWarmSandcastleSandbox implements WarmSandcastleSandboxHandle {
  readonly containerIdentity?: { containerName?: string; containerId?: string };

  get worktreePath(): string {
    return this.adapter.worktreePath;
  }

  constructor(
    private readonly adapter: PackageRuntimeAdapter,
    private readonly createAgentProvider: (selection: SandcastleAgentProviderSelection) => unknown,
    containerIdentity?: { containerName?: string; containerId?: string },
  ) {
    this.containerIdentity = containerIdentity;
  }

  async run(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const selection =
      request.invocationMode === 'reviewer' ? request.plan.reviewerSandcastleProvider : request.plan.sandcastleProvider;
    if (!selection) {
      return {
        status: 'blocked',
        sessionId: request.sessionId ?? null,
        removable: false,
        unsafeReason: `Sandcastle ${request.invocationMode ?? 'execution'} provider is not configured`,
      };
    }

    const result = await this.adapter.runPhase({
      phase: request.invocationMode ?? 'execution',
      agent: this.createAgentProvider(selection),
      prompt: request.prompt,
      signal: request.signal,
    });

    return {
      status: 'completed',
      sessionId: result.sessionId ?? request.sessionId ?? null,
      removable: true,
      unsafeReason: null,
      output: result.stdout ? [result.stdout] : [],
    };
  }
}

class DefaultWarmSandcastleSandboxFactory implements WarmSandcastleSandboxFactory {
  constructor(private readonly fallbackProvider: AgentExecutionProvider) {}

  validateRuntimeImage(_plan: LaunchPlan): Promise<SandcastleRuntimeImageValidationResult> {
    return validateSandcastleRuntimeImage(new DockerSandcastleRuntimeImageClient(), AFK_RUNTIME_IMAGE);
  }

  async create(plan: LaunchPlan): Promise<WarmSandcastleSandboxHandle> {
    if (plan.sandboxMode !== 'docker' || !plan.sandcastleProvider) {
      return new ProviderBackedWarmSandcastleSandbox(this.fallbackProvider);
    }

    const packageRuntime = await import('./sandcastle-package-runtime.js');
    const preparedWorktreeReleaseBlock = releasePreparedWorktreeForSandcastle(plan);
    if (preparedWorktreeReleaseBlock) {
      return {
        run: async () => ({
          status: 'blocked',
          sessionId: null,
          removable: false,
          unsafeReason: preparedWorktreeReleaseBlock,
          output: [preparedWorktreeReleaseBlock],
        }),
      };
    }

    const runtime = await packageRuntime.createAfkSandcastleDockerRuntime({
      repoRoot: plan.repoRoot,
      branch: plan.checkout.effectiveBranchName,
      imageName: AFK_RUNTIME_IMAGE,
      mounts: collectSandcastleDockerMounts(plan),
      env: collectSandcastleDockerEnv(plan),
    });
    if (runtime.status === 'blocked') {
      return {
        run: async () => ({
          status: 'blocked',
          sessionId: null,
          removable: false,
          unsafeReason: runtime.reason,
          output: [runtime.reason],
        }),
      };
    }

    let containerIdentity: { containerName?: string; containerId?: string } | undefined;
    try {
      const identity = await runtime.adapter.identifyContainer();
      containerIdentity = { containerId: identity.id, containerName: identity.id };
    } catch {
      containerIdentity = undefined;
    }

    return new PackageWarmSandcastleSandbox(
      runtime.adapter,
      packageRuntime.createAfkSandcastleAgentProvider,
      containerIdentity,
    );
  }
}

export function collectSandcastleDockerMounts(plan: LaunchPlan) {
  const providerMounts = [plan.sandcastleProvider, plan.reviewerSandcastleProvider]
    .flatMap((provider) => provider?.docker.mounts ?? [])
    .map((mount) => ({
      hostPath: mount.source,
      sandboxPath: mount.target,
      readonly: mount.target !== AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.pi,
    }));
  // Mount .scratch/ directory so the agent can read/write ticket files
  // and scratch artifacts from inside the Docker container.
  const scratchDir = path.join(plan.repoRoot, '.scratch');
  return Array.from(
    new Map(
      [...providerMounts, { hostPath: scratchDir, sandboxPath: scratchDir, readonly: false }].map(
        (mount) => [`${mount.hostPath}:${mount.sandboxPath}`, mount],
      ),
    ).values(),
  );
}

function collectSandcastleDockerEnv(plan: LaunchPlan) {
  const names = [plan.sandcastleProvider, plan.reviewerSandcastleProvider].flatMap(
    (provider) => provider?.docker.env ?? [],
  );
  return Object.fromEntries(
    Array.from(new Set(names))
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0),
  );
}

function releasePreparedWorktreeForSandcastle(plan: LaunchPlan): string | null {
  if (plan.sandboxMode !== 'docker' || !plan.sandcastleProvider) return null;
  const worktreePath = plan.checkout.worktreePath;
  try {
    const registered = runGit(plan.repoRoot, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .some((line) => line === `worktree ${worktreePath}`);
    if (!registered) return null;
    const status = runGit(worktreePath, ['status', '--porcelain']);
    if (status.trim()) {
      return `Prepared worktree has uncommitted changes and cannot be released for Sandcastle: ${worktreePath}`;
    }
    runGit(plan.repoRoot, ['worktree', 'remove', worktreePath]);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to release prepared worktree for Sandcastle';
    return `Prepared worktree could not be released for Sandcastle: ${message}`;
  }
}

export class SingleTicketRunner {
  private readonly linearSyncer?: LinearRunSyncer;
  private readonly sandcastleSandboxFactory?: WarmSandcastleSandboxFactory;

  constructor(
    private readonly runtimeStore: RuntimeStore,
    private readonly provider: AgentExecutionProvider,
    private readonly configuredBudgets: Partial<BudgetPolicy> = {},
    linearSyncerOrCommandExecutor?: LinearRunSyncer | ReadinessCommandExecutor,
    _commandExecutor: ReadinessCommandExecutor = new SyncReadinessCommandExecutor(),
    sandcastleSandboxFactory?: WarmSandcastleSandboxFactory,
  ) {
    if (linearSyncerOrCommandExecutor && 'resolvedConfig' in linearSyncerOrCommandExecutor) {
      this.linearSyncer = linearSyncerOrCommandExecutor;
    }
    this.sandcastleSandboxFactory = sandcastleSandboxFactory;
  }

  async launch(plan: LaunchPlan, options: SingleTicketLaunchOptions = {}): Promise<SingleTicketRunResult> {
    const ticket = plan.tickets[0];
    if (!ticket) return { scheduled: false, message: 'No ticket available for launch', outcome: 'not-scheduled' };
    const ticketPathValidation = validateSelectedTicketPath(plan.repoRoot, ticket);
    if (ticketPathValidation)
      return {
        scheduled: false,
        message: ticketPathValidation.message,
        outcome: 'not-scheduled',
        launchBlock: ticketPathValidation,
      };
    options.onProgress?.({ ticketLabel: ticket.label, message: 'starting ticket run' });
    const record = this.runtimeStore.createRecord({
      featureSlug: ticket.feature,
      issueName: ticket.issueName,
      ticketPath: ticket.path,
      runId: options.runId,
      providerIdentity: ticket.providerIdentity,
      sandboxMode: plan.sandboxMode,
    });
    this.runtimeStore.appendLog(record.logPath, `ticket start: ${ticket.label}`);
    const sandcastleProvider = plan.sandcastleProvider;
    const sandcastleRuntimeStore = sandcastleProvider ? new SandcastleRuntimeStore({ repoRoot: plan.repoRoot }) : null;
    const dockerContainerName =
      plan.sandboxMode === 'docker'
        ? `afk-${ticket.feature}-${ticket.issueName}-${options.runId ?? Date.now()}`
        : undefined;
    let dockerIdentity: DockerContainerIdentity | undefined =
      plan.sandboxMode === 'docker' ? { image: AFK_RUNTIME_IMAGE, containerName: dockerContainerName } : undefined;
    const sandcastleRuntime =
      sandcastleRuntimeStore && sandcastleProvider
        ? sandcastleRuntimeStore.createRun({
            runId: options.runId ?? `${ticket.feature}-${ticket.issueName}-${Date.now()}`,
            ticket: {
              featureSlug: ticket.feature,
              issueName: ticket.issueName,
              label: ticket.label,
              ticketPath: ticket.path,
              trackerIssueId: ticket.providerIdentity?.issueId,
              trackerIssueKey: ticket.providerIdentity?.issueKey,
              trackerIssueUrl: ticket.providerIdentity?.issueUrl,
            },
            trackerSource: ticket.provider?.kind === 'linear' || ticket.source === 'linear' ? 'linear' : 'scratch',
            provider: {
              provider: sandcastleProvider.provider,
              model: sandcastleProvider.model ?? plan.model.id,
              reviewerProvider: plan.reviewerSandcastleProvider?.provider,
              reviewerModel: plan.reviewerSandcastleProvider?.model ?? plan.reviewerModel?.id,
            },
            sandbox:
              plan.sandboxMode === 'docker'
                ? {
                    mode: 'docker',
                    image: AFK_RUNTIME_IMAGE,
                    worktreePath: AFK_RUNTIME_WORKTREE_PATH,
                    containerName: dockerContainerName,
                  }
                : { mode: 'none' },
            location: {
              branch: plan.checkout.effectiveBranchName,
              worktreePath: plan.checkout.worktreePath,
            },
            logs: { run: record.logPath },
          })
        : null;
    let warmSandbox: WarmSandcastleSandboxHandle | null = null;
    const recordDockerCleanupResource = () => {
      if (!sandcastleRuntimeStore || !sandcastleRuntime || !dockerIdentity) return;
      sandcastleRuntimeStore.recordCleanupResource(sandcastleRuntime.recordPath, {
        type: 'docker-container',
        id: dockerContainerResourceId(dockerIdentity),
        path: dockerIdentity.image,
        cleanupCommand: dockerCleanupCommand(dockerIdentity),
      });
    };
    recordDockerCleanupResource();
    const completeSandcastleRun = async (
      status: 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted',
      handoffReason?: string,
    ) => {
      if (!sandcastleRuntimeStore || !sandcastleRuntime) return;
      sandcastleRuntimeStore.updateTerminal(sandcastleRuntime.recordPath, { status, handoffReason });
      if (!dockerIdentity) return;
      const resourceId = dockerContainerResourceId(dockerIdentity);
      const existingResult = sandcastleRuntimeStore
        .readRun(sandcastleRuntime.recordPath)
        .cleanupResults?.find((item) => item.resourceId === resourceId && item.resourceType === 'docker-container');
      if (existingResult) return;
      const outcome: { status: 'succeeded' | 'skipped' | 'failed'; message?: string } = warmSandbox?.cleanup
        ? await warmSandbox
            .cleanup()
            .then((result) => ({
              status: result?.status === 'skipped' ? ('skipped' as const) : ('succeeded' as const),
              message: result?.message,
            }))
            .catch((error) => ({
              status: 'failed' as const,
              message: error instanceof Error ? error.message : 'Sandcastle package Docker cleanup failed',
            }))
        : await getDefaultSandcastleDockerCleanup().removeContainer(dockerIdentity);
      sandcastleRuntimeStore.recordCleanupResult(
        sandcastleRuntime.recordPath,
        toCleanupResult(dockerIdentity, outcome),
      );
    };
    const sandcastleSandboxFactory =
      this.sandcastleSandboxFactory ?? new DefaultWarmSandcastleSandboxFactory(this.provider);
    if (sandcastleRuntime && sandcastleRuntimeStore && plan.sandboxMode === 'docker') {
      const validation = sandcastleSandboxFactory.validateRuntimeImage
        ? await sandcastleSandboxFactory.validateRuntimeImage(plan)
        : await validateSandcastleRuntimeImage(new DockerSandcastleRuntimeImageClient(), AFK_RUNTIME_IMAGE);
      if (!validation.ok) {
        const reason = validation.failure.message;
        this.runtimeStore.updateMetadata(record.metadataPath, {
          STATUS: 'blocked',
          UNSAFE_REASON: reason,
          RUN_STATUS: 'blocked',
          FAILURE_KIND: validation.failure.kind,
          SANDCASTLE_RUNTIME_IMAGE: validation.failure.image,
          SANDCASTLE_CONTAINER_WORKTREE_PATH: AFK_RUNTIME_WORKTREE_PATH,
          SANDCASTLE_PHASE_EXECUTOR_CAPABILITY: AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY,
        });
        this.runtimeStore.markFailed(record, reason);
        this.runtimeStore.appendLog(record.logPath, reason);
        sandcastleRuntimeStore.recordPhase(sandcastleRuntime.recordPath, {
          phase: 'implementation',
          status: 'blocked',
          outcome: reason,
        });
        await completeSandcastleRun('blocked', reason);
        this.emitProgress(record.metadataPath, options.onProgress, { ticketLabel: ticket.label, message: reason });
        return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
      }
      this.runtimeStore.updateMetadata(record.metadataPath, {
        SANDCASTLE_RUNTIME_IMAGE: validation.image,
        SANDCASTLE_CONTAINER_WORKTREE_PATH: AFK_RUNTIME_WORKTREE_PATH,
        SANDCASTLE_PHASE_EXECUTOR_CAPABILITY: validation.capability,
      });
    }
    try {
      warmSandbox = sandcastleRuntime ? await sandcastleSandboxFactory.create(plan) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sandcastle sandbox creation failed';
      const source = 'agent-thrown' as const;
      const classification = classifyProviderFailureFromSource(message, source);
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: 'failed',
        IMPLEMENTATION_STATUS: 'failed',
        REVIEW_STATUS: 'unknown',
        RUN_STATUS: 'failed',
        FAILURE_KIND: classification?.kind ?? 'unknown',
        PROVIDER_FAILURE_KIND: classification?.kind ?? 'unknown',
        PROVIDER_FAILURE_SOURCE: classification?.source ?? source,
        PROVIDER_FAILURE_EVIDENCE: classification?.matchedEvidence ?? message,
        UNSAFE_REASON: message,
      });
      this.runtimeStore.markFailed(record, 'failed');
      this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
      if (sandcastleRuntimeStore && sandcastleRuntime) {
        sandcastleRuntimeStore.recordPhase(sandcastleRuntime.recordPath, {
          phase: 'implementation',
          status: 'failed',
          outcome: message,
        });
      }
      await completeSandcastleRun('failed');
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: `run failed: ${message}`,
      });
      return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'failed' };
    }
    if (warmSandbox?.containerIdentity && sandcastleRuntimeStore && sandcastleRuntime && dockerIdentity) {
      dockerIdentity = {
        image: dockerIdentity.image,
        containerName: warmSandbox.containerIdentity.containerName,
        containerId: warmSandbox.containerIdentity.containerId,
      };
      sandcastleRuntimeStore.updateDockerContainerIdentity(sandcastleRuntime.recordPath, warmSandbox.containerIdentity);
      recordDockerCleanupResource();
    } else if (warmSandbox?.identifyContainer && sandcastleRuntimeStore && sandcastleRuntime && dockerIdentity) {
      const actualIdentity = await warmSandbox.identifyContainer();
      dockerIdentity = {
        image: actualIdentity.image ?? dockerIdentity.image,
        containerName: actualIdentity.containerName,
        containerId: actualIdentity.containerId,
      };
      sandcastleRuntimeStore.updateSandbox(sandcastleRuntime.recordPath, {
        mode: 'docker',
        image: dockerIdentity.image,
        worktreePath: AFK_RUNTIME_WORKTREE_PATH,
        containerName: dockerIdentity.containerName,
        containerId: dockerIdentity.containerId,
      });
      recordDockerCleanupResource();
    }
    if (warmSandbox?.worktreePath) {
      // In Docker mode, Sandcastle bind-mounts the worktree at
      // $SANDBOX_REPO_DIR and sets WORKDIR to /home/agent.
      const promptWorktreePath =
        plan.sandboxMode === 'docker' ? '/home/agent' : warmSandbox.worktreePath;
      const promptRepoRoot = plan.sandboxMode === 'docker' ? '/home/agent' : plan.repoRoot;
      const updatedCheckout = { ...plan.checkout, worktreePath: promptWorktreePath };
      const currentSnapshot = plan.snapshots?.[ticket.label];
      plan = {
        ...plan,
        checkout: updatedCheckout,
        snapshots: currentSnapshot
          ? {
              ...plan.snapshots,
              [ticket.label]: {
                ...currentSnapshot,
                repoRoot: promptRepoRoot,
                worktreePath: promptWorktreePath,
                worktreeName: path.basename(warmSandbox.worktreePath),
              },
            }
          : plan.snapshots,
      };
    }

    const runAgentPhase = async (
      phase: SandcastlePhaseName,
      attempt: number,
      request: AgentExecutionRequest,
    ): Promise<AgentExecutionResult> => {
      if (!warmSandbox || !sandcastleRuntimeStore || !sandcastleRuntime) return this.provider.execute(request);
      const startedAt = new Date().toISOString();
      const startedEpoch = Date.now();
      try {
        const result = await warmSandbox.run(request);
        sandcastleRuntimeStore.recordPhase(sandcastleRuntime.recordPath, {
          phase,
          attempt,
          status: result.status === 'completed' ? 'passed' : result.status === 'blocked' ? 'blocked' : 'failed',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedEpoch,
          outcome: result.unsafeReason ?? result.status,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sandcastle phase failed';
        sandcastleRuntimeStore.recordPhase(sandcastleRuntime.recordPath, {
          phase,
          attempt,
          status: 'failed',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedEpoch,
          outcome: message,
        });
        throw error;
      }
    };
    await this.syncLinearStarted(ticket, record);
    this.runtimeStore.appendLog(record.logPath, `model: ${plan.model.id}`);
    if (!plan.reviewerModel || !plan.reviewerPrompt) {
      const reason = 'reviewer required: no reviewer model or prompt configured';
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: 'blocked',
        UNSAFE_REASON: reason,
        RUN_STATUS: 'blocked',
      });
      this.runtimeStore.markFailed(record, reason);
      this.runtimeStore.appendLog(record.logPath, reason);
      await completeSandcastleRun('blocked', reason);
      await this.syncLinearTerminal(ticket, record, 'blocked', {
        nextAction: 'configure reviewer model and prompt',
        reviewerNotes: reason,
      });
      this.emitProgress(record.metadataPath, options.onProgress, { ticketLabel: ticket.label, message: reason });
      return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
    }

    this.runtimeStore.appendLog(record.logPath, `reviewer model: ${plan.reviewerModel.id}`);
    this.runtimeStore.appendLog(
      record.logPath,
      `reviewer prompt: ${plan.reviewerPrompt.id} (${plan.reviewerPrompt.path})`,
    );
    this.runtimeStore.updateMetadata(record.metadataPath, {
      EXECUTION_PROVIDER: plan.harness ? providerNameForHarness(plan.harness) : 'opencode',
      EXECUTION_MODEL_ID: plan.model.id,
      ...(plan.sandcastleProvider
        ? {
            SANDCASTLE_EXECUTION_PROVIDER: plan.sandcastleProvider.provider,
            SANDCASTLE_EXECUTION_MODEL_ID: plan.sandcastleProvider.model ?? null,
            SANDCASTLE_EXECUTION_DOCKER_AUTH: plan.sandcastleProvider.docker,
            SANDCASTLE_EXECUTION_NO_SANDBOX: plan.sandcastleProvider.noSandbox,
          }
        : {}),
      REVIEWER_MODEL_ID: plan.reviewerModel.id,
      ...(plan.reviewerSandcastleProvider
        ? {
            SANDCASTLE_REVIEWER_PROVIDER: plan.reviewerSandcastleProvider.provider,
            SANDCASTLE_REVIEWER_MODEL_ID: plan.reviewerSandcastleProvider.model ?? null,
            SANDCASTLE_REVIEWER_DOCKER_AUTH: plan.reviewerSandcastleProvider.docker,
            SANDCASTLE_REVIEWER_NO_SANDBOX: plan.reviewerSandcastleProvider.noSandbox,
          }
        : {}),
      REVIEWER_PROMPT_ID: plan.reviewerPrompt.id,
      REVIEWER_PROMPT_PATH: plan.reviewerPrompt.path,
    });
    const ticketContent = this.readTicketContent(ticket) ?? '';
    const reviewerPromptText = this.readReviewerPrompt(plan.reviewerPrompt);
    const budgets = this.resolveBudgets();
    this.runtimeStore.updateMetadata(record.metadataPath, { EFFECTIVE_BUDGETS: budgets });
    this.runtimeStore.appendLog(record.logPath, `effective budgets: ${JSON.stringify(budgets)}`);
    const snapshot = plan.snapshots?.[ticket.label];
    if (snapshot) this.recordSnapshotMetadata(record.metadataPath, snapshot);
    const contextMismatch = this.validateLaunchContext(plan, ticket.label);
    if (contextMismatch)
      return this.handoffForLauncherContextMismatch(ticket, record, options, contextMismatch, completeSandcastleRun);
    installCommitMessageSanitizer(plan.checkout.worktreePath);
    let prompt = buildPrompt({
      checkout: plan.checkout,
      ticket,
      ticketContent,
      snapshot,
      reviewerPrompt: plan.reviewerPrompt,
      afkInstructions: this.readAfkInstructions(plan.repoRoot),
    });
    this.runtimeStore.completePhase(
      record.metadataPath,
      record.logPath,
      this.runtimeStore.startPhase('launch-preparation'),
    );
    this.runtimeStore.completePhase(
      record.metadataPath,
      record.logPath,
      this.runtimeStore.startPhase('worktree-preparation'),
    );
    this.runtimeStore.completePhase(record.metadataPath, record.logPath, this.runtimeStore.startPhase('readiness'));
    let providerFailureCount = 0;
    let deterministicFailureCount = 0;
    let lastDeterministicFailureKind = '';
    let sessionId: string | null = null;
    let reviewCycle = 0;
    let fixupCycles = 0;
    let malformedAttempts = 0;
    let latestExecutionResult: AgentExecutionResult | null = null;
    let executeBeforeReview = true;
    let nextImplementationPhase: SandcastlePhaseName = 'implementation';
    let useReviewerRepairPrompt = false;
    let priorMalformedReviewerOutput = '';
    const ticketStartEpoch = Date.now();

    try {
      while (true) {
        if (options.signal?.aborted) {
          this.runtimeStore.appendLog(record.logPath, 'run killed');
          this.emitProgress(record.metadataPath, options.onProgress, {
            ticketLabel: ticket.label,
            message: 'run killed',
            sessionId,
          });
          await completeSandcastleRun('interrupted');
          return { scheduled: false, message: 'Run killed', outcome: 'not-scheduled' };
        }
        const ticketBudget = this.checkTicketBudget(budgets, ticketStartEpoch, reviewCycle + 1);
        if (ticketBudget)
          return this.handoffForBudget(ticket, record, options, ticketBudget, sessionId, completeSandcastleRun);
        if (executeBeforeReview && fixupCycles >= budgets.fixupCycleLimit && reviewCycle > 0) {
          return this.handoffForBudget(
            ticket,
            record,
            options,
            {
              budgetName: 'fixup-cycle-cap',
              limit: budgets.fixupCycleLimit,
              observed: fixupCycles,
              phase: 'fixup',
              cycle: reviewCycle,
              evidence: 'Real implementation fixup cycle cap reached',
            },
            sessionId,
            completeSandcastleRun,
          );
        }
        if (executeBeforeReview) {
          try {
            const executionResult = await this.runtimeStore.runPhase(
              record.metadataPath,
              record.logPath,
              'execution',
              () =>
                runAgentPhase(nextImplementationPhase, reviewCycle + 1, {
                  plan,
                  ticketIndex: 0,
                  prompt,
                  invocationMode: 'execution',
                  sessionId,
                  onProgress: this.progressLogger(record.metadataPath, record.logPath, options.onProgress),
                  signal: options.signal,
                }),
              reviewCycle + 1,
            );
            sessionId = executionResult.sessionId ?? sessionId;
            latestExecutionResult = executionResult;
            this.recordExecutionResult(record.metadataPath, record.logPath, executionResult, sessionId);
            const executionBudget = this.checkPhaseBudget(record.metadataPath, budgets, 'execution', reviewCycle + 1);
            if (executionBudget)
              return this.handoffForBudget(ticket, record, options, executionBudget, sessionId, completeSandcastleRun);
            if (executionResult.status !== 'completed') {
              return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
                this.runtimeStore.updateMetadata(record.metadataPath, {
                  STATUS: executionResult.status,
                  IMPLEMENTATION_STATUS: executionResult.status,
                  REVIEW_STATUS: 'unknown',
                  RUN_STATUS: executionResult.status === 'blocked' ? 'blocked' : 'failed',
                });
                this.runtimeStore.markFailed(record, executionResult.status);
                await completeSandcastleRun(executionResult.status === 'blocked' ? 'blocked' : 'failed');
                this.runtimeStore.appendLog(record.logPath, `run ${executionResult.status}`);
                await this.syncLinearTerminal(
                  ticket,
                  record,
                  executionResult.status === 'blocked' ? 'blocked' : 'failed',
                  {
                    nextAction: executionResult.status === 'blocked' ? 'human handoff' : 'investigate failed run',
                    reviewerNotes: executionResult.unsafeReason ?? `Execution ended with ${executionResult.status}`,
                  },
                );
                this.emitProgress(record.metadataPath, options.onProgress, {
                  ticketLabel: ticket.label,
                  message: `run ${executionResult.status}`,
                  sessionId,
                });
                return {
                  scheduled: true,
                  message: `Scheduled ${ticket.label}`,
                  outcome: executionResult.status === 'blocked' ? 'blocked' : 'failed',
                };
              });
            }
            // Execution completed successfully
            nextImplementationPhase = 'implementation';
            this.runtimeStore.updateMetadata(record.metadataPath, {
              IMPLEMENTATION_STATUS: 'completed',
            });
            latestExecutionResult = executionResult;
          } catch (error) {
            if (options.signal?.aborted) {
              this.runtimeStore.appendLog(record.logPath, 'run killed');
              this.emitProgress(record.metadataPath, options.onProgress, {
                ticketLabel: ticket.label,
                message: 'run killed',
                sessionId,
              });
              await completeSandcastleRun('interrupted');
              return { scheduled: false, message: 'Run killed', outcome: 'not-scheduled' };
            }
            providerFailureCount += 1;
            const message = error instanceof Error ? error.message : 'provider execution failed';
            const source = 'agent-thrown' as const;
            const classification = classifyProviderFailureFromSource(message, source);
            const isDeterministic = classification ? isDeterministicFailureKind(classification.kind) : false;
            if (isDeterministic && classification) {
              if (lastDeterministicFailureKind === classification.kind) {
                deterministicFailureCount += 1;
              } else {
                deterministicFailureCount = 1;
                lastDeterministicFailureKind = classification.kind;
              }
            } else {
              deterministicFailureCount = 0;
              lastDeterministicFailureKind = '';
            }
            this.runtimeStore.appendLog(
              record.logPath,
              `provider failure ${providerFailureCount}/${budgets.providerFailureRetries}: ${message}`,
            );
            if (isDeterministic && deterministicFailureCount >= budgets.deterministicProviderFailureRetries) {
              this.runtimeStore.updateMetadata(record.metadataPath, {
                STATUS: 'failed',
                IMPLEMENTATION_STATUS: 'failed',
                REVIEW_STATUS: 'unknown',
                RUN_STATUS: 'failed',
                FAILURE_KIND: classification?.kind ?? 'unknown',
                PROVIDER_FAILURE_KIND: classification?.kind ?? 'unknown',
                PROVIDER_FAILURE_SOURCE: classification?.source ?? source,
                PROVIDER_FAILURE_EVIDENCE: classification?.matchedEvidence ?? message,
                DETERMINISTIC_PROVIDER_FAILURE: true,
                UNSAFE_REASON: message,
              });
              return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
                this.runtimeStore.markFailed(record, 'failed');
                this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
                await completeSandcastleRun('failed');
                await this.syncLinearTerminal(ticket, record, 'failed', {
                  nextAction: 'investigate failed run',
                  reviewerNotes: message,
                });
                this.emitProgress(record.metadataPath, options.onProgress, {
                  ticketLabel: ticket.label,
                  message: `run failed: ${message}`,
                  sessionId,
                });
                return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'failed' };
              });
            }
            if (providerFailureCount <= budgets.providerFailureRetries) {
              this.emitProgress(record.metadataPath, options.onProgress, {
                ticketLabel: ticket.label,
                message: `provider failure retry ${providerFailureCount}/${budgets.providerFailureRetries}`,
                sessionId,
              });
              executeBeforeReview = true;
              continue;
            }
            return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
              this.runtimeStore.updateMetadata(record.metadataPath, {
                STATUS: 'failed',
                IMPLEMENTATION_STATUS: 'failed',
                REVIEW_STATUS: 'unknown',
                RUN_STATUS: 'failed',
                FAILURE_KIND: classification?.kind ?? 'unknown',
                PROVIDER_FAILURE_KIND: classification?.kind ?? 'unknown',
                PROVIDER_FAILURE_SOURCE: classification?.source ?? source,
                PROVIDER_FAILURE_EVIDENCE: classification?.matchedEvidence ?? message,
                UNSAFE_REASON: message,
              });
              this.runtimeStore.markFailed(record, 'failed');
              this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
              await completeSandcastleRun('failed');
              await this.syncLinearTerminal(ticket, record, 'failed', {
                nextAction: 'investigate failed run',
                reviewerNotes: message,
              });
              this.emitProgress(record.metadataPath, options.onProgress, {
                ticketLabel: ticket.label,
                message: `run failed: ${message}`,
                sessionId,
              });
              return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'failed' };
            });
          }
        }
        if (!latestExecutionResult)
          return { scheduled: false, message: 'No execution result available for review', outcome: 'not-scheduled' };
        const executionForReview = latestExecutionResult;
        const updatedTicketContent = this.readRunResultContent(ticket, latestExecutionResult);
        if (updatedTicketContent === null) {
          return this.handoffForTicketReadFailure(ticket, record, options, sessionId, completeSandcastleRun);
        }

        const reviewResult = await this.runtimeStore.runPhase(
          record.metadataPath,
          record.logPath,
          'review',
          () =>
            runAgentPhase(useReviewerRepairPrompt ? 'reviewer-repair' : 'review', reviewCycle + 1, {
              plan,
              ticketIndex: 0,
              prompt: useReviewerRepairPrompt
                ? this.buildReviewerRepairPrompt(
                    ticket.label,
                    reviewerPromptText,
                    sessionId,
                    executionForReview,
                    updatedTicketContent,
                    snapshot,
                    priorMalformedReviewerOutput,
                  )
                : this.buildReviewerPrompt(
                    ticket.label,
                    reviewerPromptText,
                    sessionId,
                    executionForReview,
                    updatedTicketContent,
                    snapshot,
                  ),
              invocationMode: 'reviewer',
              sessionId: null,
              onProgress: this.progressLogger(record.metadataPath, record.logPath, options.onProgress),
              signal: options.signal,
            }),
          reviewCycle + 1,
        );
        useReviewerRepairPrompt = false;
        const reviewBudget = this.checkPhaseBudget(record.metadataPath, budgets, 'review', reviewCycle + 1);
        if (reviewBudget)
          return this.handoffForBudget(ticket, record, options, reviewBudget, sessionId, completeSandcastleRun);
        const afterReviewTicketBudget = this.checkTicketBudget(budgets, ticketStartEpoch, reviewCycle + 1);
        if (afterReviewTicketBudget)
          return this.handoffForBudget(
            ticket,
            record,
            options,
            afterReviewTicketBudget,
            sessionId,
            completeSandcastleRun,
          );
        this.runtimeStore.appendLog(record.logPath, `reviewer session: ${reviewResult.sessionId ?? 'unknown'}`);
        if (reviewResult.status !== 'completed') {
          providerFailureCount += 1;
          const message =
            reviewResult.unsafeReason ??
            ((reviewResult.output ?? []).join('\n') || `reviewer returned ${reviewResult.status}`);
          const source: 'provider-error' | 'agent-thrown' = reviewResult.unsafeReason?.trim()
            ? 'provider-error'
            : 'agent-thrown';
          const classification = classifyProviderFailureFromSource(message, source);
          const isDeterministic = classification ? isDeterministicFailureKind(classification.kind) : false;
          if (isDeterministic && classification) {
            if (lastDeterministicFailureKind === classification.kind) {
              deterministicFailureCount += 1;
            } else {
              deterministicFailureCount = 1;
              lastDeterministicFailureKind = classification.kind;
            }
          } else {
            deterministicFailureCount = 0;
            lastDeterministicFailureKind = '';
          }
          this.runtimeStore.appendLog(
            record.logPath,
            `provider failure ${providerFailureCount}/${budgets.providerFailureRetries}: ${message}`,
          );
          if (isDeterministic && deterministicFailureCount >= budgets.deterministicProviderFailureRetries) {
            this.runtimeStore.updateMetadata(record.metadataPath, {
              STATUS: 'blocked',
              REVIEW_STATUS: 'failed',
              RUN_STATUS: 'handoff',
              FAILURE_KIND: classification?.kind ?? 'unknown',
              PROVIDER_FAILURE_KIND: classification?.kind ?? 'unknown',
              PROVIDER_FAILURE_SOURCE: classification?.source ?? source,
              PROVIDER_FAILURE_EVIDENCE: classification?.matchedEvidence ?? message,
              DETERMINISTIC_PROVIDER_FAILURE: true,
              UNSAFE_REASON: message,
            });
            this.runtimeStore.recordFinalReviewOutcome(
              record.metadataPath,
              record.logPath,
              this.buildFinalOutcomeRecord({
                outcome: 'needs-human',
                reason: `Reviewer infrastructure failure after implementation completed: ${message}`,
                cycle: reviewCycle + 1,
                classification: 'review-target-mismatch',
              }),
            );
            return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
              await completeSandcastleRun('handoff', message);
              this.runtimeStore.markHandoff(record, `reviewer provider failure: ${classification?.kind ?? 'unknown'}`);
              this.runtimeStore.appendLog(
                record.logPath,
                `run handoff: reviewer provider failure after implementation completed`,
              );
              await this.syncLinearTerminal(ticket, record, 'handoff', {
                nextAction: 'human review required',
                reviewerNotes: message,
              });
              this.emitProgress(record.metadataPath, options.onProgress, {
                ticketLabel: ticket.label,
                message: `run handoff: reviewer provider failure after implementation completed`,
                sessionId: reviewResult.sessionId ?? sessionId,
              });
              return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'handoff' };
            });
          }
          if (providerFailureCount <= budgets.providerFailureRetries) {
            this.runtimeStore.updateMetadata(record.metadataPath, {
              STATUS: 'interrupted',
              UNSAFE_REASON: message,
            });
            this.emitProgress(record.metadataPath, options.onProgress, {
              ticketLabel: ticket.label,
              message: `provider failure retry ${providerFailureCount}/${budgets.providerFailureRetries}`,
              sessionId: reviewResult.sessionId ?? sessionId,
            });
            executeBeforeReview = false;
            continue;
          }
          return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
            await completeSandcastleRun('handoff', message);
            this.runtimeStore.updateMetadata(record.metadataPath, {
              STATUS: 'blocked',
              REVIEW_STATUS: 'failed',
              RUN_STATUS: 'handoff',
              FAILURE_KIND: classification?.kind ?? 'unknown',
              PROVIDER_FAILURE_KIND: classification?.kind ?? 'unknown',
              PROVIDER_FAILURE_SOURCE: classification?.source ?? source,
              PROVIDER_FAILURE_EVIDENCE: classification?.matchedEvidence ?? message,
              UNSAFE_REASON: message,
            });
            this.runtimeStore.recordFinalReviewOutcome(
              record.metadataPath,
              record.logPath,
              this.buildFinalOutcomeRecord({
                outcome: 'needs-human',
                reason: `Reviewer infrastructure failure after implementation completed: ${message}`,
                cycle: reviewCycle + 1,
              }),
            );
            this.runtimeStore.markHandoff(record, 'handoff');
            this.runtimeStore.appendLog(
              record.logPath,
              `run handoff: reviewer provider failure after implementation completed`,
            );
            await this.syncLinearTerminal(ticket, record, 'handoff', {
              nextAction: 'human review required',
              reviewerNotes: message,
            });
            this.emitProgress(record.metadataPath, options.onProgress, {
              ticketLabel: ticket.label,
              message: `run handoff: reviewer provider failure after implementation completed`,
              sessionId: reviewResult.sessionId ?? sessionId,
            });
            return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'handoff' };
          });
        }
        const rawReviewOutput = (reviewResult.output ?? []).join('\n');
        const review = parseReviewerOutput(rawReviewOutput);

        if (review.fallback) {
          malformedAttempts += 1;
          if (malformedAttempts <= budgets.malformedReviewerRetries) {
            const malformedRetryMessage = `${rawReviewOutput.trim() ? 'malformed reviewer output' : 'empty reviewer output'} retry ${malformedAttempts}/${budgets.malformedReviewerRetries}`;
            this.runtimeStore.appendLog(record.logPath, malformedRetryMessage);
            this.emitProgress(record.metadataPath, options.onProgress, {
              ticketLabel: ticket.label,
              message: malformedRetryMessage,
              sessionId,
            });
            executeBeforeReview = false;
            useReviewerRepairPrompt = true;
            priorMalformedReviewerOutput = rawReviewOutput;
            continue;
          }
          return rawReviewOutput.trim()
            ? this.handoffForMalformedReview(
                ticket,
                record,
                options,
                review.raw,
                reviewCycle + 1,
                sessionId,
                completeSandcastleRun,
              )
            : this.handoffForEmptyReview(
                ticket,
                record,
                options,
                reviewCycle + 1,
                sessionId,
                completeSandcastleRun,
                plan.checkout.worktreePath,
              );
        }

        malformedAttempts = 0;
        priorMalformedReviewerOutput = '';
        const decision = decideReviewOutcome(review, {
          cycle: reviewCycle + 1,
          maxCycles: budgets.fixupCycleLimit + 1,
        });
        this.runtimeStore.recordReviewCycle(
          record.metadataPath,
          record.logPath,
          this.buildReviewCycleEntry(reviewCycle + 1, decision),
        );

        if (decision.targetMismatch) {
          return this.handoffForReviewTargetMismatch(
            ticket,
            record,
            options,
            reviewCycle + 1,
            sessionId,
            completeSandcastleRun,
          );
        }

        if (decision.decision === 'approve') {
          return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
            await completeSandcastleRun('completed');
            const classification: ReviewOutcomeClassification = 'clean-approval';
            this.runtimeStore.recordFinalReviewOutcome(
              record.metadataPath,
              record.logPath,
              this.buildFinalOutcomeRecord({
                outcome: 'approved',
                reason: decision.reason,
                cycle: reviewCycle + 1,
                classification,
                malformed: false,
                findings: decision.findings.map((finding) => ({
                  severity: finding.severity,
                  summary: finding.title,
                  detail: finding.detail,
                })),
              }),
            );
            this.runtimeStore.updateMetadata(record.metadataPath, {
              STATUS: 'completed',
              REVIEW_STATUS: 'approved',
              RUN_STATUS: 'completed',
            });
            // The reviewer is responsible for finalizing the ticket status and committing any
            // leftover source changes. Verify it happened and apply safety-net fixes if needed.
            const ticketPath =
              ticket.provider?.materializedFiles?.ticketPath ??
              ticket.provider?.materializedFiles?.runSummaryPath ??
              ticket.path;
            if (ticketPath) {
              this.ensureTicketStatusDone(ticketPath, record.logPath);
            }
            if (this.hasUncommittedChanges(plan.checkout.worktreePath)) {
              this.commitUncommittedChanges(plan.checkout.worktreePath, ticket.label, record.logPath);
            }
            // Attempt merge-back into feature branch so subsequent waves can build on this work
            const featureCheckout = plan.checkouts?.[ticket.feature];
            if (featureCheckout && featureCheckout.effectiveBranchName !== plan.checkout.effectiveBranchName) {
              try {
                discardWorktreeChanges(featureCheckout.worktreePath);
                runGit(featureCheckout.worktreePath, ['merge', '--no-edit', plan.checkout.effectiveBranchName]);
                this.runtimeStore.appendLog(
                  record.logPath,
                  `merged ${plan.checkout.effectiveBranchName} into ${featureCheckout.effectiveBranchName}`,
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : 'merge failed';
                this.runtimeStore.appendLog(record.logPath, `merge-back failed: ${message}`);
              }
            }
            this.runtimeStore.markDone(record);
            this.runtimeStore.appendLog(record.logPath, 'run completed');
            await this.syncLinearTerminal(ticket, record, 'completed', {
              nextAction: 'none; AFK run approved',
              reviewerNotes: decision.reason,
              commits: this.recentCommitLines(plan.checkout.worktreePath),
            });
            this.emitProgress(record.metadataPath, options.onProgress, {
              ticketLabel: ticket.label,
              message: 'run completed',
              sessionId,
            });
            return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'completed' };
          });
        }

        if (decision.decision === 'needs-human') {
          const classification: ReviewOutcomeClassification =
            decision.findings.length === 0 ? 'missing-findings-handoff' : 'real-finding-handoff';
          this.runtimeStore.updateMetadata(record.metadataPath, {
            STATUS: 'blocked',
            REVIEW_STATUS: 'needs-human',
            RUN_STATUS: 'blocked',
            UNSAFE_REASON: decision.reason,
          });
          this.runtimeStore.recordFinalReviewOutcome(
            record.metadataPath,
            record.logPath,
            this.buildFinalOutcomeRecord({
              outcome: 'needs-human',
              reason: decision.reason,
              cycle: reviewCycle + 1,
              classification,
              malformed: false,
              findings: decision.findings.map((finding) => ({
                severity: finding.severity,
                summary: finding.title,
                detail: finding.detail,
              })),
            }),
          );
          return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
            await completeSandcastleRun('handoff', decision.reason);
            this.runtimeStore.markFailed(record, 'needs-human handoff required');
            this.runtimeStore.appendLog(record.logPath, `needs-human handoff: ${decision.reason}`);
            this.runtimeStore.appendLog(record.logPath, 'run blocked');
            await this.syncLinearTerminal(ticket, record, 'blocked', {
              nextAction: 'human review required',
              reviewerNotes: decision.reason,
            });
            this.emitProgress(record.metadataPath, options.onProgress, {
              ticketLabel: ticket.label,
              message: 'run blocked',
              sessionId,
            });
            return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
          });
        }

        reviewCycle += 1;
        fixupCycles += 1;
        const priorImplementationSessionId = sessionId;
        prompt = await this.runtimeStore.runPhase(
          record.metadataPath,
          record.logPath,
          'fixup',
          () => this.buildFixupPrompt(ticket.label, priorImplementationSessionId, reviewCycle, review),
          reviewCycle,
        );
        this.runtimeStore.appendLog(
          record.logPath,
          `starting fresh implementation session for fixup; prior session: ${priorImplementationSessionId ?? 'unknown'}`,
        );
        sessionId = null;
        nextImplementationPhase = 'fixup';
        const fixupBudget = this.checkPhaseBudget(record.metadataPath, budgets, 'fixup', reviewCycle);
        if (fixupBudget)
          return this.handoffForBudget(ticket, record, options, fixupBudget, sessionId, completeSandcastleRun);
        executeBeforeReview = true;
      }
    } catch (error) {
      if (options.signal?.aborted) {
        this.runtimeStore.appendLog(record.logPath, 'run killed');
        this.emitProgress(record.metadataPath, options.onProgress, {
          ticketLabel: ticket.label,
          message: 'run killed',
        });
        await completeSandcastleRun('interrupted');
        return { scheduled: false, message: 'Run killed', outcome: 'not-scheduled' };
      }
      const message = error instanceof Error ? error.message : 'provider execution failed';
      const source = 'agent-thrown' as const;
      const classification = classifyProviderFailureFromSource(message, source);
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: 'failed',
        RUN_STATUS: 'failed',
        FAILURE_KIND: classification?.kind ?? 'unknown',
        PROVIDER_FAILURE_KIND: classification?.kind ?? 'unknown',
        PROVIDER_FAILURE_SOURCE: classification?.source ?? source,
        PROVIDER_FAILURE_EVIDENCE: classification?.matchedEvidence ?? message,
        UNSAFE_REASON: message,
      });
      this.runtimeStore.markFailed(record, 'failed');
      this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
      await completeSandcastleRun('failed');
      await this.syncLinearTerminal(ticket, record, 'failed', {
        nextAction: 'investigate failed run',
        reviewerNotes: message,
      });
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: `run failed: ${message}`,
      });
    }
    return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'failed' };
  }

  private resolveBudgets(): BudgetPolicy {
    return {
      ...DEFAULT_BUDGET_POLICY,
      ...this.configuredBudgets,
    };
  }

  private checkTicketBudget(
    budgets: BudgetPolicy,
    ticketStartEpoch: number,
    cycle: number,
  ): BudgetExceededEvent | null {
    const limit = budgets.ticketWallClockMs;
    if (!limit) return null;
    const observed = Date.now() - ticketStartEpoch;
    if (observed <= limit) return null;
    return {
      budgetName: 'ticket-wall-clock-ms',
      limit,
      observed,
      phase: 'ticket',
      cycle,
      evidence: `Ticket runtime exceeded wall-clock budget (${observed}ms > ${limit}ms)`,
    };
  }

  private checkPhaseBudget(
    metadataPath: string,
    budgets: BudgetPolicy,
    phase: BudgetPhaseName,
    cycle: number,
  ): BudgetExceededEvent | null {
    const limit = budgets.phaseWallClockMs?.[phase];
    if (!limit) return null;
    const metadata = this.runtimeStore.readMetadata(metadataPath);
    const latest = [...(metadata.PHASE_HISTORY ?? [])]
      .reverse()
      .find((entry) => entry.name === phase && entry.cycle === cycle);
    if (!latest || latest.durationMs <= limit) return null;
    return {
      budgetName: `phase-${phase}-wall-clock-ms`,
      limit,
      observed: latest.durationMs,
      phase,
      cycle,
      evidence: `Phase ${phase} exceeded wall-clock budget (${latest.durationMs}ms > ${limit}ms)`,
    };
  }

  private handoffForBudget(
    ticket: TicketRecord,
    record: RuntimeRecordHandle,
    options: { onProgress?: AgentExecutionProgressCallback },
    event: BudgetExceededEvent,
    sessionId: string | null,
    completeSandcastleRun?: (
      status: 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted',
      handoffReason?: string,
    ) => Promise<void> | void,
  ): Promise<SingleTicketRunResult> {
    this.runtimeStore.recordBudgetExceeded(record.metadataPath, record.logPath, event);
    const reason = `budget exceeded: ${event.budgetName} (limit=${event.limit}, observed=${event.observed}, phase=${event.phase}, cycle=${event.cycle})`;
    // Preserve implementation success if it was already achieved
    const metadata = this.runtimeStore.readMetadata(record.metadataPath);
    const implementationCompleted = metadata.IMPLEMENTATION_STATUS === 'completed';
    this.runtimeStore.updateMetadata(record.metadataPath, {
      STATUS: 'blocked',
      UNSAFE_REASON: reason,
      FAILURE_KIND: 'needs-human',
      RUN_STATUS: implementationCompleted ? 'handoff' : 'blocked',
    });
    this.runtimeStore.recordFinalReviewOutcome(
      record.metadataPath,
      record.logPath,
      this.buildFinalOutcomeRecord({
        outcome: 'needs-human',
        reason,
        cycle: event.cycle,
        classification: event.budgetName === 'fixup-cycle-cap' ? 'real-finding-handoff' : undefined,
      }),
    );
    return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
      await completeSandcastleRun?.(implementationCompleted ? 'handoff' : 'blocked', reason);
      if (implementationCompleted) {
        this.runtimeStore.markHandoff(record, reason);
      } else {
        this.runtimeStore.markFailed(record, reason);
      }
      this.runtimeStore.appendLog(record.logPath, `needs-human handoff: ${reason}`);
      this.runtimeStore.appendLog(record.logPath, 'run blocked');
      await this.syncLinearTerminal(ticket, record, implementationCompleted ? 'handoff' : 'blocked', {
        nextAction: 'human review required',
        reviewerNotes: reason,
      });
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: `budget handoff: ${reason}`,
        sessionId,
      });
      return {
        scheduled: true,
        message: `Scheduled ${ticket.label}`,
        outcome: implementationCompleted ? 'handoff' : 'blocked',
      };
    });
  }

  private handoffForMalformedReview(
    ticket: TicketRecord,
    record: RuntimeRecordHandle,
    options: { onProgress?: AgentExecutionProgressCallback },
    raw: string,
    cycle: number,
    sessionId: string | null,
    completeSandcastleRun?: (
      status: 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted',
      handoffReason?: string,
    ) => Promise<void> | void,
  ): Promise<SingleTicketRunResult> {
    const malformedHandoffReason = 'Malformed reviewer output repeated after format-repair retry';
    const malformedOutputSnippet = this.boundSnippet(raw);
    this.runtimeStore.updateMetadata(record.metadataPath, {
      STATUS: 'blocked',
      UNSAFE_REASON: malformedHandoffReason,
      FAILURE_KIND: REVIEWER_OUTPUT_MALFORMED_FAILURE_KIND,
      REVIEW_STATUS: 'needs-human',
      RUN_STATUS: 'blocked',
    });
    this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, {
      cycle,
      outcome: 'handoff-required',
      reason: malformedHandoffReason,
      malformed: true,
      findings: [],
      classification: 'malformed-output-handoff',
      malformedOutputSnippet,
    });
    this.runtimeStore.recordFinalReviewOutcome(
      record.metadataPath,
      record.logPath,
      this.buildFinalOutcomeRecord({
        cycle,
        outcome: 'needs-human',
        reason: malformedHandoffReason,
        classification: 'malformed-output-handoff',
        malformed: true,
        findings: [],
        malformedOutputSnippet,
      }),
    );
    return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
      await completeSandcastleRun?.('handoff', malformedHandoffReason);
      this.runtimeStore.markFailed(record, 'needs-human handoff required');
      this.runtimeStore.appendLog(record.logPath, 'malformed reviewer output handoff: reviewer-output-malformed');
      this.runtimeStore.appendLog(record.logPath, 'run blocked');
      await this.syncLinearTerminal(ticket, record, 'blocked', {
        nextAction: 'human review required',
        reviewerNotes: malformedHandoffReason,
      });
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: 'malformed reviewer output handoff',
        sessionId,
      });
      return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
    });
  }

  private handoffForEmptyReview(
    ticket: TicketRecord,
    record: RuntimeRecordHandle,
    options: { onProgress?: AgentExecutionProgressCallback },
    cycle: number,
    sessionId: string | null,
    completeSandcastleRun:
      | ((
          status: 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted',
          handoffReason?: string,
        ) => Promise<void> | void)
      | undefined,
    worktreePath: string,
  ): Promise<SingleTicketRunResult> {
    const reason = 'Reviewer returned empty output after format-repair retry';
    const ticketPath = ticket.provider?.materializedFiles?.ticketPath ?? ticket.path;
    const stateCheck = this.evaluateTicketStateForApproval(ticketPath, worktreePath);

    if (stateCheck.approved) {
      const approvalReason = 'empty reviewer output, but ticket state indicates approval; finalizing';
      const classification: ReviewOutcomeClassification = 'state-approval';
      this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, {
        cycle,
        outcome: 'approve',
        reason: approvalReason,
        malformed: true,
        findings: [],
        classification,
        malformedOutputSnippet: '',
      });
      this.runtimeStore.recordFinalReviewOutcome(
        record.metadataPath,
        record.logPath,
        this.buildFinalOutcomeRecord({
          cycle,
          outcome: 'approved',
          reason: approvalReason,
          classification,
          malformed: true,
          findings: [],
          malformedOutputSnippet: '',
        }),
      );
      return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
        await completeSandcastleRun?.('completed');
        this.runtimeStore.updateMetadata(record.metadataPath, {
          STATUS: 'completed',
          UNSAFE_REASON: null,
          FAILURE_KIND: null,
          REVIEW_STATUS: 'approved',
          RUN_STATUS: 'completed',
          STATE_APPROVAL_FALLBACK: approvalReason,
        });
        if (ticketPath) {
          this.ensureTicketStatusDone(ticketPath, record.logPath);
        }
        this.runtimeStore.markDone(record);
        this.runtimeStore.appendLog(record.logPath, approvalReason);
        this.runtimeStore.appendLog(record.logPath, 'run completed');
        await this.syncLinearTerminal(ticket, record, 'completed', {
          nextAction: 'none; AFK run approved via state-based fallback',
          reviewerNotes: approvalReason,
          commits: this.recentCommitLines(worktreePath),
        });
        this.emitProgress(record.metadataPath, options.onProgress, {
          ticketLabel: ticket.label,
          message: 'run completed via state-based fallback',
          sessionId,
        });
        return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'completed' };
      });
    }

    this.runtimeStore.updateMetadata(record.metadataPath, {
      STATUS: 'blocked',
      UNSAFE_REASON: reason,
      FAILURE_KIND: REVIEWER_EMPTY_OUTPUT_FAILURE_KIND,
      REVIEW_STATUS: 'needs-human',
      RUN_STATUS: 'blocked',
      STATE_APPROVAL_FALLBACK: `state-based approval skipped: ${stateCheck.reason}`,
    });
    this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, {
      cycle,
      outcome: 'handoff-required',
      reason,
      malformed: true,
      findings: [],
      classification: 'empty-output-handoff',
      malformedOutputSnippet: '',
    });
    this.runtimeStore.recordFinalReviewOutcome(
      record.metadataPath,
      record.logPath,
      this.buildFinalOutcomeRecord({
        cycle,
        outcome: 'needs-human',
        reason,
        classification: 'empty-output-handoff',
        malformed: true,
        findings: [],
        malformedOutputSnippet: '',
      }),
    );
    return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
      await completeSandcastleRun?.('handoff', reason);
      this.runtimeStore.markFailed(record, 'needs-human handoff required');
      this.runtimeStore.appendLog(record.logPath, 'empty reviewer output handoff: reviewer-empty-output');
      this.runtimeStore.appendLog(record.logPath, 'run blocked');
      await this.syncLinearTerminal(ticket, record, 'blocked', {
        nextAction: 'human review required',
        reviewerNotes: reason,
      });
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: 'empty reviewer output handoff',
        sessionId,
      });
      return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
    });
  }

  private handoffForReviewTargetMismatch(
    ticket: TicketRecord,
    record: RuntimeRecordHandle,
    options: { onProgress?: AgentExecutionProgressCallback },
    cycle: number,
    sessionId: string | null,
    completeSandcastleRun?: (
      status: 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted',
      handoffReason?: string,
    ) => Promise<void> | void,
  ): Promise<SingleTicketRunResult> {
    const reason = 'Reviewer detected review target mismatch';
    this.runtimeStore.updateMetadata(record.metadataPath, {
      STATUS: 'blocked',
      UNSAFE_REASON: reason,
      FAILURE_KIND: REVIEW_TARGET_MISMATCH_FAILURE_KIND,
      REVIEW_STATUS: 'needs-human',
      RUN_STATUS: 'blocked',
    });
    this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, {
      cycle,
      outcome: 'handoff-required',
      reason,
      malformed: false,
      findings: [],
      classification: 'review-target-mismatch',
    });
    this.runtimeStore.recordFinalReviewOutcome(
      record.metadataPath,
      record.logPath,
      this.buildFinalOutcomeRecord({
        cycle,
        outcome: 'needs-human',
        reason,
        classification: 'review-target-mismatch',
        malformed: false,
        findings: [],
      }),
    );
    return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
      await completeSandcastleRun?.('handoff', reason);
      this.runtimeStore.markFailed(record, 'needs-human handoff required');
      this.runtimeStore.appendLog(record.logPath, 'review target mismatch handoff: review-target-mismatch');
      this.runtimeStore.appendLog(record.logPath, 'run blocked');
      await this.syncLinearTerminal(ticket, record, 'blocked', {
        nextAction: 'human review required',
        reviewerNotes: reason,
      });
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: 'review target mismatch handoff',
        sessionId,
      });
      return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
    });
  }

  private handoffForLauncherContextMismatch(
    ticket: TicketRecord,
    record: RuntimeRecordHandle,
    options: { onProgress?: AgentExecutionProgressCallback },
    reason: string,
    completeSandcastleRun?: (
      status: 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted',
      handoffReason?: string,
    ) => Promise<void> | void,
  ): Promise<SingleTicketRunResult> {
    this.runtimeStore.updateMetadata(record.metadataPath, {
      STATUS: 'blocked',
      UNSAFE_REASON: reason,
      FAILURE_KIND: LAUNCHER_CONTEXT_MISMATCH_FAILURE_KIND,
      RUN_STATUS: 'blocked',
    });
    return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
      await completeSandcastleRun?.('handoff', reason);
      this.runtimeStore.markFailed(record, reason);
      this.runtimeStore.appendLog(record.logPath, `launcher context mismatch: ${reason}`);
      this.runtimeStore.appendLog(record.logPath, 'run blocked');
      await this.syncLinearTerminal(ticket, record, 'blocked', {
        nextAction: 'human review required',
        reviewerNotes: reason,
      });
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: 'launcher context mismatch',
      });
      return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
    });
  }

  private handoffForTicketReadFailure(
    ticket: TicketRecord,
    record: RuntimeRecordHandle,
    options: { onProgress?: AgentExecutionProgressCallback },
    sessionId: string | null,
    completeSandcastleRun?: (
      status: 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted',
      handoffReason?: string,
    ) => Promise<void> | void,
  ): Promise<SingleTicketRunResult> {
    const reason = 'updated ticket context could not be read before review';
    this.runtimeStore.updateMetadata(record.metadataPath, {
      STATUS: 'blocked',
      UNSAFE_REASON: reason,
      FAILURE_KIND: TICKET_READ_FAILURE_KIND,
      RUN_STATUS: 'blocked',
    });
    return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', async () => {
      await completeSandcastleRun?.('handoff', reason);
      this.runtimeStore.markFailed(record, reason);
      this.runtimeStore.appendLog(record.logPath, `ticket read failure: ${reason}`);
      await this.syncLinearTerminal(ticket, record, 'blocked', {
        nextAction: 'human review required',
        reviewerNotes: reason,
      });
      this.emitProgress(record.metadataPath, options.onProgress, {
        ticketLabel: ticket.label,
        message: reason,
        sessionId,
      });
      return { scheduled: true, message: `Scheduled ${ticket.label}`, outcome: 'blocked' };
    });
  }

  private validateLaunchContext(plan: LaunchPlan, ticketLabel: string): string | null {
    const ticket = plan.tickets[0];
    const snapshot = plan.snapshots?.[ticketLabel];
    if (!ticket || !snapshot) return null;
    if (snapshot.featureSlug !== ticket.feature)
      return `snapshot feature ${snapshot.featureSlug} does not match ticket feature ${ticket.feature}`;
    if (plan.checkout.featureSlug !== ticket.feature)
      return `checkout feature ${plan.checkout.featureSlug} does not match ticket feature ${ticket.feature}`;
    const checkoutPath = path.resolve(plan.checkout.worktreePath);
    const snapshotPath = path.resolve(snapshot.worktreePath);
    if (snapshotPath !== checkoutPath)
      return `snapshot worktree ${snapshotPath} does not match checkout worktree ${checkoutPath}`;
    return null;
  }

  private async syncLinearStarted(ticket: TicketRecord, record: RuntimeRecordHandle): Promise<void> {
    if (!this.linearSyncer || ticket.providerIdentity?.provider !== 'linear') return;
    try {
      await syncLinearRunStarted({
        ticket,
        resolvedConfig: this.linearSyncer.resolvedConfig,
        client: this.linearSyncer.client,
      });
      this.runtimeStore.updateMetadata(record.metadataPath, { LINEAR_SYNC_STATUS: 'running-synced' });
      this.runtimeStore.appendLog(record.logPath, `linear sync: ${ticket.providerIdentity.issueKey} set to running`);
    } catch (error) {
      this.recordLinearSyncFailure(record, error);
    }
  }

  private async syncLinearTerminal(
    ticket: TicketRecord,
    record: RuntimeRecordHandle,
    outcome: 'completed' | 'blocked' | 'failed' | 'handoff',
    details: { nextAction: string; reviewerNotes?: string; caveats?: string; tests?: string; commits?: string[] },
  ): Promise<void> {
    if (!this.linearSyncer || ticket.providerIdentity?.provider !== 'linear') return;
    try {
      const metadata = this.runtimeStore.readMetadata(record.metadataPath);
      await syncLinearRunTerminal({
        summary: {
          ticket,
          metadata,
          outcome,
          nextAction: details.nextAction,
          reviewerNotes: details.reviewerNotes,
          caveats: details.caveats,
          tests: details.tests,
          commits: details.commits,
        },
        resolvedConfig: this.linearSyncer.resolvedConfig,
        client: this.linearSyncer.client,
      });
      this.runtimeStore.updateMetadata(record.metadataPath, { LINEAR_SYNC_STATUS: 'terminal-synced' });
      this.runtimeStore.appendLog(
        record.logPath,
        `linear sync: ${ticket.providerIdentity.issueKey} terminal ${outcome}`,
      );
    } catch (error) {
      this.recordLinearSyncFailure(record, error);
    }
  }

  private recordLinearSyncFailure(record: RuntimeRecordHandle, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const metadata = this.runtimeStore.readMetadata(record.metadataPath);
    const failures = [...(metadata.LINEAR_SYNC_FAILURES ?? []), message];
    this.runtimeStore.updateMetadata(record.metadataPath, {
      LINEAR_SYNC_STATUS: 'failed',
      LINEAR_SYNC_FAILURES: failures,
    });
    this.runtimeStore.appendLog(record.logPath, `linear sync failed: ${message}`);
  }

  private recentCommitLines(worktreePath: string): string[] {
    try {
      return runGit(worktreePath, ['log', '--oneline', '-5'])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private ensureTicketStatusDone(ticketPath: string, logPath: string): boolean {
    try {
      const content = readFileSync(ticketPath, 'utf8');
      if (!content.startsWith('---\n')) {
        this.runtimeStore.appendLog(logPath, `ticket finalization skipped: ${ticketPath} has no YAML frontmatter`);
        return false;
      }
      const end = content.indexOf('\n---\n', 4);
      if (end === -1) {
        this.runtimeStore.appendLog(
          logPath,
          `ticket finalization skipped: ${ticketPath} has unclosed YAML frontmatter`,
        );
        return false;
      }
      const frontmatterText = content.slice(4, end);
      const parsed = YAML.parse(frontmatterText) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.runtimeStore.appendLog(logPath, `ticket finalization skipped: ${ticketPath} frontmatter is not a mapping`);
        return false;
      }
      const currentStatus = String(parsed.status ?? '').trim();
      if (currentStatus === 'done') {
        return true;
      }
      parsed.status = 'done';
      const newFrontmatter = YAML.stringify(parsed, { lineWidth: 0 }).trimEnd();
      const newContent = `---\n${newFrontmatter}\n---\n${content.slice(end + 5)}`;
      writeFileSync(ticketPath, newContent, 'utf8');
      this.runtimeStore.appendLog(logPath, `ticket finalization: set status to done in ${ticketPath}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runtimeStore.appendLog(logPath, `ticket finalization failed: ${message}`);
      return false;
    }
  }

  private hasUncommittedChanges(worktreePath: string): boolean {
    try {
      const status = runGit(worktreePath, ['status', '--porcelain']).trim();
      return status.length > 0;
    } catch {
      return false;
    }
  }

  private commitUncommittedChanges(worktreePath: string, ticketLabel: string, logPath: string): void {
    try {
      runGit(worktreePath, ['add', '-A']);
      runGit(worktreePath, ['commit', '-m', `chore(ticket): finalize ${ticketLabel}`]);
      this.runtimeStore.appendLog(logPath, `ticket finalization: committed uncommitted changes for ${ticketLabel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runtimeStore.appendLog(logPath, `ticket finalization commit failed: ${message}`);
    }
  }

  private evaluateTicketStateForApproval(
    ticketPath: string | null | undefined,
    worktreePath: string,
  ): { approved: boolean; reason: string } {
    if (!ticketPath) {
      return { approved: false, reason: 'no ticket path available' };
    }
    const content = this.readTicketContent(ticketPath);
    if (content === null) {
      return { approved: false, reason: 'ticket file could not be read' };
    }
    if (!content.startsWith('---\n')) {
      return { approved: false, reason: 'ticket has no YAML frontmatter' };
    }
    const end = content.indexOf('\n---\n', 4);
    if (end === -1) {
      return { approved: false, reason: 'ticket frontmatter is unclosed' };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = YAML.parse(content.slice(4, end)) as Record<string, unknown>;
    } catch {
      return { approved: false, reason: 'ticket frontmatter is invalid YAML' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { approved: false, reason: 'ticket frontmatter is not a mapping' };
    }
    if (String(parsed.status ?? '').trim() !== 'done') {
      return { approved: false, reason: 'ticket status is not done' };
    }
    if (!/^##\s+AFK\s+Summary\s*$/m.test(content)) {
      return { approved: false, reason: 'ticket is missing ## AFK Summary' };
    }
    if (!/^###\s+Reviewer\s+Notes\s*$/m.test(content)) {
      return { approved: false, reason: 'ticket is missing ### Reviewer Notes' };
    }
    if (this.hasUncommittedChanges(worktreePath)) {
      return { approved: false, reason: 'worktree has uncommitted changes' };
    }
    return {
      approved: true,
      reason: 'ticket status is done and summary/reviewer notes are present with clean worktree',
    };
  }

  private readTicketContent(ticketOrPath: TicketRecord | string): string | null {
    const ticketPath = typeof ticketOrPath === 'string' ? ticketOrPath : ticketOrPath.path;
    if (!ticketPath) return null;
    try {
      return readFileSync(ticketPath, 'utf8');
    } catch {
      if (typeof ticketOrPath !== 'string' && ticketOrPath.source === 'linear') return ticketOrPath.content ?? '';
      return null;
    }
  }

  private readRunResultContent(
    ticket: LaunchPlan['tickets'][number],
    executionResult: AgentExecutionResult,
  ): string | null {
    if ((ticket.provider?.kind ?? 'scratch') === 'scratch') return this.readTicketContent(ticket.path);
    const runSummaryPath = ticket.provider?.materializedFiles?.runSummaryPath;
    const runSummaryContent = this.readTicketContent(runSummaryPath ?? '');
    if (runSummaryContent !== null)
      return this.buildProviderRunResultContent(ticket, [
        runSummaryPath ? `Run summary artifact: ${runSummaryPath}` : undefined,
        '',
        runSummaryContent.trimEnd(),
      ]);
    const mirrorPath = ticket.provider?.materializedFiles?.ticketPath ?? ticket.path;
    const updatedTicketContent = this.readTicketContent(mirrorPath);
    if (updatedTicketContent !== null)
      return this.buildProviderRunResultContent(ticket, [
        mirrorPath ? `Managed local mirror: ${mirrorPath}` : undefined,
        '',
        updatedTicketContent.trimEnd(),
      ]);
    const output = executionResult.output?.join('\n').trim();
    return this.buildProviderRunResultContent(ticket, [output ? `\n## Execution Output\n\n${output}` : undefined]);
  }

  private buildProviderRunResultContent(
    ticket: LaunchPlan['tickets'][number],
    contentLines: Array<string | undefined>,
  ): string {
    return [
      `Provider-backed ticket: ${ticket.label}`,
      `Provider: ${ticket.provider?.kind ?? 'unknown'}`,
      ticket.provider?.displayId ? `Provider display ID: ${ticket.provider.displayId}` : undefined,
      ticket.provider?.url ? `Provider URL: ${ticket.provider.url}` : undefined,
      ...contentLines,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private readAfkInstructions(repoRoot: string): string | undefined {
    try {
      return readFileSync(`${repoRoot}/src/prompts/afk-prompt.md`, 'utf8');
    } catch {
      return undefined;
    }
  }

  private readReviewerPrompt(prompt: ReviewerPromptTemplate): string {
    return prompt.content ?? readFileSync(prompt.path, 'utf8');
  }

  private progressLogger(
    metadataPath: string,
    logPath: string,
    onProgress: AgentExecutionProgressCallback | undefined,
  ): AgentExecutionProgressCallback {
    const observedSessionIds = new Set<string>();
    const staleRecoveryPattern = /stale recovery attempt \d+\/\d+/i;
    return (event) => {
      if (event.sessionId && !observedSessionIds.has(event.sessionId)) {
        observedSessionIds.add(event.sessionId);
        const metadata = this.runtimeStore.readMetadata(metadataPath);
        if (!metadata.PROVIDER_SESSION_ID) {
          this.runtimeStore.updateMetadata(metadataPath, {
            PROVIDER_SESSION_ID: event.sessionId,
            PROVIDER_SESSION_REMOVABLE: false,
            UNSAFE_REASON:
              metadata.UNSAFE_REASON === 'session capture pending' ? 'session still running' : metadata.UNSAFE_REASON,
          });
          this.runtimeStore.appendLog(logPath, `provider session observed: ${event.sessionId}`);
        }
      }
      if (event.toolName && event.toolStatus === 'running') {
        this.runtimeStore.updateMetadata(metadataPath, {
          LAST_ACTIVE_TOOL_NAME: event.toolName,
          LAST_ACTIVE_TOOL_STARTED_AT: new Date().toISOString(),
        });
      }
      if (event.message && staleRecoveryPattern.test(event.message)) {
        const metadata = this.runtimeStore.readMetadata(metadataPath);
        this.runtimeStore.updateMetadata(metadataPath, {
          STALE_RECOVERY_COUNTS: (metadata.STALE_RECOVERY_COUNTS ?? 0) + 1,
        });
        this.runtimeStore.appendLog(logPath, `stale recovery count: ${(metadata.STALE_RECOVERY_COUNTS ?? 0) + 1}`);
      }
      if (event.kind === 'permission') this.runtimeStore.appendLog(logPath, `permission required: ${event.message}`);
      else if (event.kind === 'failure') this.runtimeStore.appendLog(logPath, event.message);
      else if (event.permissionId) this.runtimeStore.appendLog(logPath, `permission event: ${event.message}`);
      else if (event.message) this.runtimeStore.appendLog(logPath, event.message);
      onProgress?.(event);
    };
  }

  private recordExecutionResult(
    metadataPath: string,
    logPath: string,
    result: {
      status: string;
      sessionId?: string | null;
      removable?: boolean;
      unsafeReason?: string | null;
      output?: string[];
      inspectionTargetIdentifier?: string | null;
    },
    sessionId: string | null,
  ): void {
    this.runtimeStore.appendLog(logPath, `provider session: ${sessionId ?? 'unknown'}`);
    // Only classify from structured unsafeReason, not arbitrary output prose
    const failureSource = result.unsafeReason ? ('provider-error' as const) : ('unknown' as const);
    const classification = result.unsafeReason
      ? classifyProviderFailureFromSource(result.unsafeReason, failureSource)
      : null;
    this.runtimeStore.updateMetadata(metadataPath, {
      STATUS: normalizeStatus(result.status),
      IMPLEMENTATION_STATUS: normalizeStatus(result.status),
      PROVIDER_SESSION_ID: sessionId,
      PROVIDER_SESSION_REMOVABLE: result.removable ?? false,
      UNSAFE_REASON: result.unsafeReason ?? null,
      FAILURE_KIND: result.status === 'completed' ? null : (classification?.kind ?? 'unknown'),
      PROVIDER_FAILURE_KIND: result.status === 'completed' ? null : (classification?.kind ?? 'unknown'),
      PROVIDER_FAILURE_SOURCE: result.status === 'completed' ? null : (classification?.source ?? failureSource),
      PROVIDER_FAILURE_EVIDENCE:
        result.status === 'completed' ? null : (classification?.matchedEvidence ?? result.unsafeReason ?? null),
      INSPECTION_PROVIDER: result.inspectionTargetIdentifier ? 'tmux' : null,
      INSPECTION_TARGET_IDENTIFIER: result.inspectionTargetIdentifier ?? null,
    });
    (result.output ?? []).forEach((line) => {
      this.runtimeStore.appendLog(logPath, line);
    });
  }

  private buildReviewerPrompt(
    ticketLabel: string,
    reviewerPromptText: string,
    sessionId: string | null,
    executionResult: { status: string; output?: string[] },
    updatedTicketContent: string,
    snapshot?: AfkStateSnapshot,
  ): string {
    return [
      reviewerPromptText.trim(),
      '',
      `Ticket: ${ticketLabel}`,
      `Execution session: ${sessionId ?? 'unknown'}`,
      `Execution status: ${executionResult.status}`,
      '',
      ...(snapshot ? this.buildReviewerTargetContext(snapshot) : []),
      'Updated ticket content:',
      '```markdown',
      updatedTicketContent.trimEnd(),
      '```',
      ...(executionResult.output?.length ? ['', 'Execution output:', ...executionResult.output] : []),
    ].join('\n');
  }

  private buildReviewerRepairPrompt(
    ticketLabel: string,
    reviewerPromptText: string,
    sessionId: string | null,
    executionResult: { status: string; output?: string[] },
    updatedTicketContent: string,
    snapshot?: AfkStateSnapshot,
    priorRawReviewerOutput = '',
  ): string {
    return [
      this.buildReviewerPrompt(
        ticketLabel,
        reviewerPromptText,
        sessionId,
        executionResult,
        updatedTicketContent,
        snapshot,
      ),
      '',
      priorRawReviewerOutput.trim() ? REVIEWER_FORMAT_REPAIR_INSTRUCTIONS : REVIEWER_EMPTY_REPAIR_INSTRUCTIONS,
    ].join('\n');
  }

  private buildReviewerTargetContext(snapshot: AfkStateSnapshot): string[] {
    return [
      '## Review Target',
      '',
      'Before producing findings, validate that you are inspecting the intended checkout:',
      `- Repo root: ${snapshot.repoRoot}`,
      `- Worktree path: ${snapshot.worktreePath}`,
      `- Branch: ${snapshot.branchName}`,
      `- Ticket path: ${snapshot.ticketPath}`,
      ...(snapshot.featurePrdPath ? [`- PRD path: ${snapshot.featurePrdPath}`] : []),
      `- Scratch feature path: ${snapshot.scratchFeaturePath}`,
      '',
      'If the worktree path or branch does not match the expected values above, do not produce code findings.',
      'Instead, return exactly: {"done":false,"summary":"Review target mismatch: [explain what is wrong]","targetMismatch":true,"findings":[]}',
      'Do not request cosmetic fixup commits for stale or wrong-worktree findings.',
      '',
    ];
  }

  private buildFixupPrompt(
    ticketLabel: string,
    priorSessionId: string | null,
    cycleCount: number,
    review: ReturnType<typeof parseReviewerOutput>,
  ): string {
    return [
      `AFK follow-up for ${ticketLabel}`,
      'Start a fresh implementation session for this fixup.',
      `Prior implementation session for reference only: ${priorSessionId ?? 'unknown'}`,
      `Review cycle: ${cycleCount}`,
      FIXUP_REMEDIATION_GUIDANCE,
      'Inspect the current repository state before editing, including git status, relevant diffs, and recent commits.',
      'Do not redo completed work. Make only incremental changes needed for these reviewer findings.',
      'Do not create cosmetic fixup commits for stale or wrong-worktree findings.',
      `Reviewer summary: ${review.summary}`,
      'Reviewer findings:',
      ...review.findings.map((finding) => {
        const detail = finding.detail ? ` - ${finding.detail}` : '';
        return `- ${finding.severity}: ${finding.title}${detail}`;
      }),
    ].join('\n');
  }

  private buildReviewCycleEntry(
    cycle: number,
    decision: ReturnType<typeof decideReviewOutcome>,
  ): ReviewCycleHistoryEntry {
    const hasRealFindings = decision.findings.some(
      (finding) => finding.severity === 'major' || finding.severity === 'blocker',
    );
    return {
      cycle,
      outcome:
        decision.decision === 'approve'
          ? 'approve'
          : decision.decision === 'needs-human'
            ? 'handoff-required'
            : 'loop-required',
      reason: decision.reason,
      malformed: decision.fallback,
      findings: decision.findings.map((finding) => ({
        severity: finding.severity,
        summary: finding.title,
        detail: finding.detail,
      })),
      classification: decision.targetMismatch
        ? 'review-target-mismatch'
        : decision.decision === 'approve'
          ? decision.findings.length === 0
            ? 'clean-approval'
            : 'minor-risk-approval'
          : hasRealFindings
            ? decision.decision === 'needs-human'
              ? 'real-finding-handoff'
              : 'real-finding-loop'
            : decision.findings.length === 0
              ? 'missing-findings-handoff'
              : undefined,
    };
  }

  private buildFinalOutcomeRecord(outcome: ReviewTerminalOutcomeRecord): ReviewTerminalOutcomeRecord {
    return {
      ...outcome,
      malformedOutputSnippet: outcome.malformedOutputSnippet
        ? this.boundSnippet(outcome.malformedOutputSnippet)
        : outcome.malformedOutputSnippet,
    };
  }

  private boundSnippet(raw: string): string {
    return raw.slice(0, MAX_MALFORMED_OUTPUT_SNIPPET_CHARS);
  }

  private emitProgress(
    metadataPath: string,
    onProgress: AgentExecutionProgressCallback | undefined,
    event: AgentExecutionProgressEvent,
  ): void {
    try {
      const metadata = this.runtimeStore.readMetadata(metadataPath);
      onProgress?.({
        ...event,
        metadata: {
          FAILURE_KIND: metadata.FAILURE_KIND,
          FINAL_REVIEW_OUTCOME: metadata.FINAL_REVIEW_OUTCOME,
          FINAL_REVIEW_REASON: metadata.FINAL_REVIEW_REASON,
          FINAL_REVIEW_CLASSIFICATION: metadata.FINAL_REVIEW_CLASSIFICATION,
          PHASE_HISTORY: metadata.PHASE_HISTORY,
        },
      });
    } catch {
      onProgress?.(event);
    }
  }

  private recordSnapshotMetadata(metadataPath: string, snapshot: NonNullable<LaunchPlan['snapshots']>[string]): void {
    this.runtimeStore.updateMetadata(metadataPath, {
      SNAPSHOT_GENERATED_AT: snapshot.generatedAt,
      SNAPSHOT_SAFE_FIELDS: {
        ticketLabel: snapshot.ticketLabel,
        featureSlug: snapshot.featureSlug,
        ticketPath: snapshot.ticketPath,
        scratchFeaturePath: snapshot.scratchFeaturePath,
        featurePrdPath: snapshot.featurePrdPath,
        repoRoot: snapshot.repoRoot,
        worktreePath: snapshot.worktreePath,
        worktreeName: snapshot.worktreeName,
        branchName: snapshot.branchName,
        head: snapshot.head,
        ticketOutsideWorktree: snapshot.ticketOutsideWorktree,
        providerIdentity: snapshot.providerIdentity,
        mirrorPath: snapshot.mirrorPath,
        dependencyCount: snapshot.dependencies.length,
        readinessSourcePath: snapshot.readiness?.sourcePath ?? null,
      },
    });
  }
}

function installCommitMessageSanitizer(worktreePath: string): void {
  try {
    const rawHookPath = runGit(worktreePath, ['rev-parse', '--git-path', 'hooks/commit-msg']).trim();
    const hookPath = path.isAbsolute(rawHookPath) ? rawHookPath : path.resolve(worktreePath, rawHookPath);
    mkdirSync(path.dirname(hookPath), { recursive: true });
    writeFileSync(
      hookPath,
      [
        '#!/bin/sh',
        'message_file="$1"',
        'tmp_file="$1.afk-sanitized"',
        'grep -viE \'^(co-authored-by:|generated-by:|ai-generated-by:|opencode:)\' "$message_file" > "$tmp_file"',
        'mv "$tmp_file" "$message_file"',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(hookPath, 0o755);
  } catch {
    // Non-git test doubles and invalid worktrees are handled by existing launch validation paths.
  }
}

function normalizeStatus(status: string): 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' {
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'blocked' ||
    status === 'unknown'
  )
    return status;
  return 'unknown';
}

function discardWorktreeChanges(worktreePath: string): void {
  runGit(worktreePath, ['reset', '--hard', 'HEAD']);
  runGit(worktreePath, ['clean', '-fd']);
}
