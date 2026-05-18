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
  tickets: TicketRecord[];
  repoRoot: string;
  gitContext: GitContext;
  checkout: CheckoutContext;
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
