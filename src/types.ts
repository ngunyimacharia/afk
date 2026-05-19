export interface TicketRecord {
  path: string;
  feature: string;
  issueName: string;
  label: string;
  status?: string;
  executorAfk: boolean;
  dependsOn?: string[];
}

export interface LaunchBlockEvidence {
  kind: 'path-validation';
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

export interface LaunchPreferences {
  harness?: 'OpenCode';
  modelId?: string;
  reviewerModelId?: string;
  concurrency?: number;
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
  worktreePath: string;
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
  repoRoot: string;
  worktreePath: string;
  worktreeName: string;
  branchName: string;
  head: string;
  gitStatusShort: string[];
  ticketOutsideWorktree: boolean;
  dependencies: DependencySnapshot[];
  readiness: ReadinessSnapshot | null;
}

export interface LaunchPlan {
  model: LaunchModel;
  reviewerModel?: LaunchModel;
  reviewerPrompt?: ReviewerPromptTemplate;
  tickets: TicketRecord[];
  repoRoot: string;
  gitContext: GitContext;
  checkout: CheckoutContext;
  checkouts?: Record<string, CheckoutContext>;
  snapshots?: Record<string, AfkStateSnapshot>;
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

export interface ReviewCycleHistoryEntry {
  cycle: number;
  outcome: ReviewCycleOutcome;
  reason: string;
  malformed: boolean;
  findings: ReviewFindingSnapshot[];
}

export interface ReviewTerminalOutcomeRecord {
  outcome: ReviewTerminalOutcome;
  reason: string;
  cycle: number;
}

export interface RuntimeMetadataRecord {
  TICKET_PATH: string;
  FEATURE_SLUG: string;
  ISSUE_NAME: string;
  LOG_PATH: string;
  START_TIME: string;
  START_EPOCH: number;
  DONE_SENTINEL_PATH: string;
  FAILED_SENTINEL_PATH: string;
  STATUS: string;
  EXECUTION_PROVIDER: string;
  EXECUTION_MODEL_ID?: string;
  REVIEWER_MODEL_ID?: string;
  REVIEWER_PROMPT_ID?: string;
  REVIEWER_PROMPT_PATH?: string;
  REVIEW_CYCLE_HISTORY?: ReviewCycleHistoryEntry[];
  FINAL_REVIEW_OUTCOME?: ReviewTerminalOutcome | null;
  FINAL_REVIEW_REASON?: string | null;
  FINAL_REVIEW_CYCLE?: number | null;
  PROVIDER_SESSION_ID: string | null;
  PROVIDER_SESSION_REMOVABLE: boolean;
  INSPECTION_PROVIDER: string | null;
  INSPECTION_TARGET_IDENTIFIER: string | null;
  FAILURE_KIND?: string | null;
  UNSAFE_REASON: string | null;
  SNAPSHOT_GENERATED_AT?: string;
  SNAPSHOT_SAFE_FIELDS?: {
    ticketLabel: string;
    featureSlug: string;
    ticketPath: string;
    repoRoot: string;
    worktreePath: string;
    worktreeName: string;
    branchName: string;
    head: string;
    ticketOutsideWorktree: boolean;
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
  permissionId?: string | null;
  permissionPatterns?: string[];
  permissionType?: string | null;
  permissionTitle?: string | null;
}

export type AgentExecutionProgressCallback = (event: AgentExecutionProgressEvent) => void;
