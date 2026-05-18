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

export interface LaunchPlan {
  model: LaunchModel;
  tickets: TicketRecord[];
  repoRoot: string;
  gitContext: GitContext;
}
