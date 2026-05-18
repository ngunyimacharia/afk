export interface TicketRecord {
  path: string;
  feature: string;
  issueName: string;
  label: string;
  status?: string;
  executorAfk: boolean;
}

export interface LaunchModel {
  id: string;
  label?: string;
}

export interface ReviewerPromptReference {
  id: string;
  path: string;
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

export interface LaunchPlan {
  model: LaunchModel;
  reviewerModel: LaunchModel;
  reviewerPrompt: ReviewerPromptReference;
  tickets: TicketRecord[];
  repoRoot: string;
  gitContext: GitContext;
  checkout: CheckoutContext;
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
  UNSAFE_REASON: string | null;
}

export interface AgentExecutionResult {
  status: 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown';
  sessionId?: string | null;
  removable?: boolean;
  unsafeReason?: string | null;
  output?: string[];
  inspectionTargetIdentifier?: string | null;
}
