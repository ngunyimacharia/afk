import type { SelectableHarnessId } from './harness-registry.js';
import type { ReadinessCheckMetadata } from './readiness-service.js';
import type { SandcastleAgentProviderSelection } from './sandcastle-provider.js';

export interface TicketRecord {
  path: string;
  feature: string;
  featureTitle?: string;
  issueName: string;
  label: string;
  title?: string;
  status?: string;
  executorAfk: boolean;
  dependsOn?: string[];
  source?: 'scratch' | 'linear';
  linear?: {
    parentKey: string;
    issueKey: string;
    parentBranchName?: string | null;
    issueBranchName?: string | null;
  };
  content?: string;
  providerIdentity?: LinearProviderIdentity;
  provider?: TicketProviderContext;
}

export interface LinearProviderIdentity {
  provider: 'linear';
  issueId: string;
  issueKey: string;
  issueUrl: string;
  parentKey: string;
  mirrorPath?: string;
}

export interface TicketProviderContext {
  kind: string;
  id: string;
  displayId?: string;
  url?: string;
  materializedFiles?: {
    ticketPath?: string;
    scratchFeaturePath?: string;
    featurePrdPath?: string;
    runtimeMetadataPath?: string;
    logPath?: string;
    runSummaryPath?: string;
  };
  runResultInstructions?: string[];
}

export interface LaunchBlockEvidence {
  kind: 'path-validation' | 'linear-identity';
  message: string;
  ticketLabel: string;
  feature: string;
  issueName: string;
  path: string;
}

export interface LaunchModel {
  id: string;
  label?: string;
}

export type FeatureCompletionAction = 'merge-to-base' | 'create-pr';
export type SandboxMode = 'docker' | 'no-sandbox';
export type SandcastleSandboxMode = SandboxMode;

export interface LaunchPreferences {
  harness?: SelectableHarnessId;
  modelId?: string;
  reviewerHarness?: SelectableHarnessId;
  reviewerModelId?: string;
  sandcastleSandboxMode?: SandcastleSandboxMode;
  concurrency?: number;
  budgets?: Partial<BudgetPolicy>;
  featureCompletionAction?: FeatureCompletionAction;
  mergeBackToBase?: boolean;
  sandboxMode?: SandboxMode;
}

export interface BudgetPolicy {
  malformedReviewerRetries: number;
  fixupCycleLimit: number;
  providerFailureRetries: number;
  deterministicProviderFailureRetries: number;
  ticketWallClockMs?: number;
  phaseWallClockMs?: Partial<Record<BudgetPhaseName, number>>;
}

export type BudgetPhaseName = 'execution' | 'review' | 'fixup';

export interface BudgetExceededEvent {
  budgetName: string;
  limit: number;
  observed: number;
  phase: string;
  cycle: number;
  evidence: string;
}

export interface ReviewerPromptTemplate {
  id: string;
  label: string;
  path: string;
  content?: string;
}

export interface GitContext {
  commits: string[];
}

export interface CheckoutContext {
  featureSlug: string;
  defaultWorktreeName: string;
  effectiveWorktreeName: string;
  defaultBranchName: string;
  effectiveBranchName: string;
  branchNameSource: 'linear' | 'override' | 'fallback';
  worktreePath: string;
  readiness?: CheckoutReadinessMetadata;
}

export type CheckoutReadinessDecision = 'copied' | 'missing-source' | 'already-present' | 'blocked-external-symlink';

export interface CheckoutReadinessCopyRecord {
  name: string;
  decision: CheckoutReadinessDecision;
  sourcePath: string;
  targetPath: string;
  note?: string;
}

export interface CheckoutReadinessMetadata {
  dependencyCopies: CheckoutReadinessCopyRecord[];
  envTestingCopy: CheckoutReadinessCopyRecord;
  checks?: ReadinessCheckMetadata;
}

export interface DependencySnapshot {
  label: string;
  issueName: string;
  status: string;
  doneSentinel: 'present' | 'missing' | 'unknown';
  failedSentinel: 'present' | 'missing' | 'unknown';
  runtimeStatus: string;
}

export interface ReadinessSnapshot {
  sourcePath: string;
  dependencyCopy: string;
  envTesting: string;
  disabledTests: string;
  smokeTest: string;
  staticReadiness: string;
  styleReadiness: string;
}

export interface AfkStateSnapshot {
  generatedAt: string;
  ticketLabel: string;
  ticketStatus: string;
  ticketIssueName: string;
  featureSlug: string;
  ticketPath: string;
  scratchFeaturePath: string;
  featurePrdPath?: string;
  repoRoot: string;
  worktreePath: string;
  worktreeName: string;
  branchName: string;
  head: string;
  gitStatusShort: string[];
  ticketOutsideWorktree: boolean;
  providerIdentity?: LinearProviderIdentity;
  mirrorPath?: string;
  dependencies: DependencySnapshot[];
  readiness: ReadinessSnapshot | null;
}

export interface LaunchPlan {
  harness?: SelectableHarnessId;
  model: LaunchModel;
  sandcastleProvider?: SandcastleAgentProviderSelection;
  reviewerHarness?: SelectableHarnessId;
  reviewerModel?: LaunchModel;
  reviewerSandcastleProvider?: SandcastleAgentProviderSelection;
  reviewerPrompt?: ReviewerPromptTemplate;
  sandboxMode?: SandboxMode;
  tickets: TicketRecord[];
  repoRoot: string;
  gitContext: GitContext;
  checkout: CheckoutContext;
  checkouts?: Record<string, CheckoutContext>;
  ticketCheckouts?: Record<string, CheckoutContext>;
  snapshots?: Record<string, AfkStateSnapshot>;
  featureDependencies?: Record<string, string[]>;
}

export interface ReviewFindingSnapshot {
  severity: string;
  summary: string;
  detail?: string;
  path?: string;
  line?: number;
}

export type ReviewCycleOutcome = 'approve' | 'loop-required' | 'handoff-required';

export type ReviewTerminalOutcome = 'approved' | 'needs-human';

export type ReviewOutcomeClassification =
  | 'clean-approval'
  | 'minor-risk-approval'
  | 'real-finding-loop'
  | 'real-finding-handoff'
  | 'malformed-output-handoff'
  | 'empty-output-handoff'
  | 'missing-findings-handoff'
  | 'review-target-mismatch';

export interface ReviewCycleHistoryEntry {
  cycle: number;
  outcome: ReviewCycleOutcome;
  reason: string;
  malformed: boolean;
  findings: ReviewFindingSnapshot[];
  classification?: ReviewOutcomeClassification;
  malformedOutputSnippet?: string;
}

export interface ReviewTerminalOutcomeRecord {
  outcome: ReviewTerminalOutcome;
  reason: string;
  cycle: number;
  classification?: ReviewOutcomeClassification;
  malformed?: boolean;
  findings?: ReviewFindingSnapshot[];
  malformedOutputSnippet?: string;
}

export type ImplementationStatus = 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' | 'not-started';
export type ReviewStatus = 'approved' | 'needs-human' | 'failed' | 'unavailable' | 'unknown' | 'not-started';
export type RunStatus = 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted' | 'unknown';
export type ProviderFailureSource = 'provider-error' | 'agent-output' | 'agent-thrown' | 'unknown';

export interface PhaseHistoryEntry {
  name: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  cycle?: number;
}

export interface RuntimeMetadataRecord {
  RUN_ID?: string;
  TICKET_PATH: string;
  FEATURE_SLUG: string;
  ISSUE_NAME: string;
  LOG_PATH: string;
  START_TIME: string;
  START_EPOCH: number;
  DONE_SENTINEL_PATH: string;
  FAILED_SENTINEL_PATH: string;
  LINEAR_ISSUE_ID?: string;
  LINEAR_ISSUE_KEY?: string;
  LINEAR_ISSUE_URL?: string;
  LINEAR_PARENT_KEY?: string;
  LINEAR_MIRROR_PATH?: string;
  LINEAR_SYNC_STATUS?: 'running-synced' | 'terminal-synced' | 'failed' | null;
  LINEAR_SYNC_FAILURES?: string[];
  PROVIDER_IDENTITY?: LinearProviderIdentity;
  STATUS: string;
  EXECUTION_PROVIDER: string;
  SANDBOX_MODE?: SandboxMode;
  EXECUTION_MODEL_ID?: string;
  SANDCASTLE_SANDBOX_MODE?: SandcastleSandboxMode;
  SANDCASTLE_BRANCH?: string;
  SANDCASTLE_WORKTREE_PATH?: string;
  SANDCASTLE_PROVIDER?: string;
  SANDCASTLE_LOG_PATH?: string;
  SANDCASTLE_PHASE_RESULT?: {
    phase: 'implementation';
    status: ImplementationStatus;
    stdout?: string;
    error?: string;
  };
  SANDCASTLE_COMMITS?: string[];
  REVIEWER_MODEL_ID?: string;
  REVIEWER_PROMPT_ID?: string;
  REVIEWER_PROMPT_PATH?: string;
  REVIEW_CYCLE_HISTORY?: ReviewCycleHistoryEntry[];
  PHASE_HISTORY?: PhaseHistoryEntry[];
  FINAL_REVIEW_OUTCOME?: ReviewTerminalOutcome | null;
  FINAL_REVIEW_REASON?: string | null;
  FINAL_REVIEW_CYCLE?: number | null;
  EFFECTIVE_BUDGETS?: BudgetPolicy;
  BUDGET_EXCEEDED_EVENTS?: BudgetExceededEvent[];
  FINAL_REVIEW_CLASSIFICATION?: ReviewOutcomeClassification | null;
  FINAL_REVIEW_MALFORMED?: boolean | null;
  FINAL_REVIEW_FINDINGS?: ReviewFindingSnapshot[];
  FINAL_REVIEW_MALFORMED_OUTPUT_SNIPPET?: string | null;
  PROVIDER_SESSION_ID: string | null;
  PROVIDER_SESSION_REMOVABLE: boolean;
  INSPECTION_PROVIDER: string | null;
  INSPECTION_TARGET_IDENTIFIER: string | null;
  FAILURE_KIND?: string | null;
  UNSAFE_REASON: string | null;
  IMPLEMENTATION_STATUS?: ImplementationStatus;
  REVIEW_STATUS?: ReviewStatus;
  RUN_STATUS?: RunStatus;
  PROVIDER_FAILURE_KIND?: string | null;
  PROVIDER_FAILURE_SOURCE?: ProviderFailureSource | null;
  PROVIDER_FAILURE_EVIDENCE?: string | null;
  DETERMINISTIC_PROVIDER_FAILURE?: boolean;
  LAST_ACTIVE_TOOL_NAME?: string | null;
  LAST_ACTIVE_TOOL_STARTED_AT?: string | null;
  STALE_RECOVERY_COUNTS?: number;
  SNAPSHOT_GENERATED_AT?: string;
  MERGE_STATUS?: 'merged' | 'conflict-resolved' | 'failed' | 'blocked' | null;
  MERGE_CONFLICT_PATHS?: string[] | null;
  MERGE_FINAL_DIAGNOSTICS?: {
    conflictPaths: string[];
    statusShort: string;
    markersRemain: boolean;
    unmergedIndexPaths: string[];
    summary: string;
  } | null;
  MERGE_RESOLUTION_OUTPUT?: string | null;
  SNAPSHOT_SAFE_FIELDS?: {
    ticketLabel: string;
    featureSlug: string;
    ticketPath: string;
    scratchFeaturePath: string;
    featurePrdPath?: string;
    repoRoot: string;
    worktreePath: string;
    worktreeName: string;
    branchName: string;
    head: string;
    ticketOutsideWorktree: boolean;
    providerIdentity?: LinearProviderIdentity;
    mirrorPath?: string;
    dependencyCount: number;
    readinessSourcePath: string | null;
  };
}

export interface AgentExecutionResult {
  status: 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown';
  sessionId?: string | null;
  removable?: boolean;
  unsafeReason?: string | null;
  output?: string[];
  inspectionTargetIdentifier?: string | null;
}

export interface AgentExecutionProgressEvent {
  ticketLabel: string;
  message: string;
  sessionId?: string | null;
  kind?: 'message' | 'permission' | 'failure';
  toolName?: string | null;
  toolStatus?: string | null;
  permissionId?: string | null;
  permissionPatterns?: string[];
  permissionType?: string | null;
  permissionTitle?: string | null;
  metadata?: Partial<RuntimeMetadataRecord>;
  timestamp?: number;
}

export type AgentExecutionProgressCallback = (event: AgentExecutionProgressEvent) => void;
