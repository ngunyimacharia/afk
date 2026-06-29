import type { AgentExecutionProvider } from './agent-execution-provider.js';
import { checkBranchWorktreesClean, removeWorktreesForBranch } from './cleanup.js';
import { discoverGithubPrTemplates, type GithubPrTemplateDiscoveryResult } from './github-pr-template-discovery.js';
import type { SchedulerTicketResult } from './scheduler.js';
import type {
  AgentExecutionProgressCallback,
  CheckoutContext,
  LaunchModel,
  LaunchPlan,
  TicketRecord,
} from './types.js';
import { runGit } from './worktree-preparation-service.js';

export interface FeaturePrCreationInput {
  repoRoot: string;
  baseBranch: string;
  features: string[];
  checkoutsByFeature: Record<string, CheckoutContext>;
  agentExecutionProvider: AgentExecutionProvider;
  model: LaunchModel;
  ticketResults?: SchedulerTicketResult[];
  onProgress?: AgentExecutionProgressCallback;
  discoverTemplates?: (repoRoot: string) => GithubPrTemplateDiscoveryResult;
  remoteBranchExists?: (repoRoot: string, branchName: string) => boolean;
  cleanupAfterCreate?: boolean;
}

export interface FeaturePrCreationResult {
  feature: string;
  branchName: string;
  success: boolean;
  prUrl?: string;
  summary?: string;
  reason?: string;
  warning?: string;
  deletedBranch: boolean;
  deletedWorktree: boolean;
}

interface ParsedPrAgentResult {
  done: boolean;
  prUrl?: string;
  summary?: string;
  reason?: string;
}

export async function createPullRequestsForCompletedFeatures(
  input: FeaturePrCreationInput,
): Promise<FeaturePrCreationResult[]> {
  const results: FeaturePrCreationResult[] = [];
  const discoverTemplates = input.discoverTemplates ?? discoverGithubPrTemplates;
  const remoteBranchExists = input.remoteBranchExists ?? defaultRemoteBranchExists;
  const cleanupAfterCreate = input.cleanupAfterCreate !== false;

  for (const feature of input.features) {
    const checkout = input.checkoutsByFeature[feature];
    if (!checkout) continue;
    const branchName = checkout.effectiveBranchName;
    const ticketLabel = `${feature}/create-pr`;

    if (branchName === input.baseBranch) {
      results.push({
        feature,
        branchName,
        success: false,
        deletedBranch: false,
        deletedWorktree: false,
        reason: `feature branch matches base branch ${input.baseBranch}; skipping PR creation`,
      });
      input.onProgress?.({
        ticketLabel,
        message: `skipping PR creation for ${feature}: feature branch matches base branch ${input.baseBranch}`,
        kind: 'failure',
      });
      continue;
    }

    input.onProgress?.({
      ticketLabel,
      message: `pushing ${branchName} and creating a GitHub pull request into ${input.baseBranch}`,
    });

    const template = discoverTemplates(input.repoRoot);
    const completedTickets = completedTicketLabelsForFeature(input.ticketResults, feature);
    const prompt = buildPullRequestPrompt({
      repoRoot: input.repoRoot,
      worktreePath: checkout.worktreePath,
      featureBranch: branchName,
      baseBranch: input.baseBranch,
      feature,
      completedTickets,
      template,
    });

    const plan = buildPrAgentPlan({
      repoRoot: input.repoRoot,
      model: input.model,
      feature,
      branchName,
      worktreePath: checkout.worktreePath,
    });

    let parsed: ParsedPrAgentResult | undefined;
    let failureReason: string | undefined;
    try {
      const agentResult = await input.agentExecutionProvider.execute({
        plan,
        ticketIndex: 0,
        prompt,
        invocationMode: 'pull-request',
        onProgress: input.onProgress,
      });
      if (agentResult.status !== 'completed') {
        failureReason = agentResult.unsafeReason ?? `PR agent ended with status ${agentResult.status}`;
      } else {
        const parseOutcome = parsePrAgentResult(agentResult.output);
        if ('malformed' in parseOutcome) {
          failureReason = 'PR agent returned malformed output';
        } else if (!parseOutcome.done) {
          failureReason = parseOutcome.reason ?? 'PR agent reported the pull request was not created';
        } else if (!parseOutcome.prUrl) {
          failureReason = 'PR agent reported success without a pull request URL';
        } else {
          parsed = parseOutcome;
        }
      }
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    }

    if (!parsed?.prUrl) {
      const reason = failureReason ?? 'PR creation failed';
      results.push({
        feature,
        branchName,
        success: false,
        deletedBranch: false,
        deletedWorktree: false,
        reason,
      });
      input.onProgress?.({
        ticketLabel,
        message: `PR creation failed for ${branchName}: ${reason}`,
        kind: 'failure',
      });
      continue;
    }

    const cleanup = cleanupAfterCreate
      ? cleanupCreatedPrFeatureBranch(input.repoRoot, checkout, remoteBranchExists)
      : { deletedBranch: false, deletedWorktree: false };

    results.push({
      feature,
      branchName,
      success: true,
      prUrl: parsed.prUrl,
      summary: parsed.summary,
      warning: 'warning' in cleanup ? cleanup.warning : undefined,
      deletedBranch: cleanup.deletedBranch,
      deletedWorktree: cleanup.deletedWorktree,
    });

    const cleanupWarning = 'warning' in cleanup ? cleanup.warning : undefined;
    input.onProgress?.({
      ticketLabel,
      message: cleanupWarning
        ? `created pull request for ${branchName}: ${parsed.prUrl}; cleanup warning: ${cleanupWarning}`
        : `created pull request for ${branchName}: ${parsed.prUrl}`,
    });
  }

  return results;
}

function completedTicketLabelsForFeature(
  ticketResults: SchedulerTicketResult[] | undefined,
  feature: string,
): string[] {
  if (!ticketResults) return [];
  return ticketResults
    .filter((result) => result.ticket.feature === feature && result.outcome === 'completed')
    .map((result) => result.ticket.label);
}

function buildPrAgentPlan(input: {
  repoRoot: string;
  model: LaunchModel;
  feature: string;
  branchName: string;
  worktreePath: string;
}): LaunchPlan {
  const ticketRecord: TicketRecord = {
    path: '',
    feature: input.feature,
    issueName: 'create-pr',
    label: `${input.feature}/create-pr`,
    executorAfk: true,
  };

  const checkout: CheckoutContext = {
    featureSlug: input.feature,
    defaultWorktreeName: input.feature,
    effectiveWorktreeName: input.feature,
    defaultBranchName: input.branchName,
    effectiveBranchName: input.branchName,
    branchNameSource: 'fallback',
    worktreePath: input.worktreePath,
  };

  return {
    repoRoot: input.repoRoot,
    model: input.model,
    tickets: [ticketRecord],
    gitContext: { commits: [] },
    checkout,
  };
}

function parsePrAgentResult(output: string[] | undefined): ParsedPrAgentResult | { malformed: true } {
  const text = (output ?? []).join('\n').trim();
  if (!text) return { malformed: true };
  const parsed = extractLastJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return { malformed: true };
  const record = parsed as Record<string, unknown>;
  if (typeof record.done !== 'boolean') return { malformed: true };
  return {
    done: record.done,
    prUrl: typeof record.prUrl === 'string' && record.prUrl.length > 0 ? record.prUrl : undefined,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  };
}

function extractLastJsonObject(text: string): unknown | undefined {
  let depth = 0;
  let start = -1;
  let lastCandidate: string | undefined;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          lastCandidate = text.slice(start, index + 1);
        }
      }
    }
  }
  if (!lastCandidate) return undefined;
  try {
    return JSON.parse(lastCandidate);
  } catch {
    return undefined;
  }
}

function defaultRemoteBranchExists(repoRoot: string, branchName: string): boolean {
  try {
    const output = runGit(repoRoot, ['ls-remote', '--heads', 'origin', branchName]);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function cleanupCreatedPrFeatureBranch(
  repoRoot: string,
  checkout: CheckoutContext,
  remoteBranchExists: (repoRoot: string, branchName: string) => boolean,
): { deletedBranch: boolean; deletedWorktree: boolean; warning?: string } {
  const branchName = checkout.effectiveBranchName;

  if (!remoteBranchExists(repoRoot, branchName)) {
    return {
      deletedBranch: false,
      deletedWorktree: false,
      warning: `skipped local cleanup: remote branch ${branchName} not found`,
    };
  }

  const cleanWorktrees = checkBranchWorktreesClean(repoRoot, branchName);
  if (!cleanWorktrees.ok) {
    return {
      deletedBranch: false,
      deletedWorktree: false,
      warning: `skipped local cleanup: ${cleanWorktrees.reason}`,
    };
  }

  const worktreeCleanup = removeWorktreesForBranch(repoRoot, branchName);
  if (!worktreeCleanup.success) {
    return {
      deletedBranch: false,
      deletedWorktree: worktreeCleanup.removedCount > 0,
      warning: `worktree cleanup failed: ${worktreeCleanup.error}`,
    };
  }

  let deletedBranch = false;
  try {
    runGit(repoRoot, ['branch', '-D', branchName]);
    deletedBranch = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('not found')) {
      return {
        deletedBranch: false,
        deletedWorktree: worktreeCleanup.removedCount > 0,
        warning: `branch delete failed: ${message}`,
      };
    }
  }

  return { deletedBranch, deletedWorktree: worktreeCleanup.removedCount > 0 };
}

function buildPullRequestPrompt(input: {
  repoRoot: string;
  worktreePath: string;
  featureBranch: string;
  baseBranch: string;
  feature: string;
  completedTickets: string[];
  template: GithubPrTemplateDiscoveryResult;
}): string {
  const completedSection =
    input.completedTickets.length > 0
      ? input.completedTickets.map((label) => `- ${label}`).join('\n')
      : '- (no per-ticket labels were provided)';

  const templateSection = buildTemplateSection(input.template);

  return `# GitHub Pull Request Creation Request

Feature: ${input.feature}
Repository root: ${input.repoRoot}
Feature worktree: ${input.worktreePath}
Feature branch: ${input.featureBranch}
Base branch: ${input.baseBranch}

## Completed Tickets

${completedSection}

${templateSection}

## What To Do

1. Verify you are operating on the feature worktree at \`${input.worktreePath}\` and that the current branch is \`${input.featureBranch}\`.
2. Inspect \`git status\`, recent commits, and the diff from \`${input.baseBranch}\` to confirm there is committed work to open a pull request for.
3. Push the feature branch \`${input.featureBranch}\` to the \`origin\` remote.
4. Create a GitHub pull request from \`${input.featureBranch}\` into \`${input.baseBranch}\` using \`gh pr create\`. Use the provided pull request template for the body when one is available.
5. If an open pull request already exists for this branch, report its URL instead of creating a duplicate.

## Hard Constraints

- Do NOT edit source files, scratch tickets, or any tracked content.
- Do NOT rebase, merge the base branch into the feature branch, force-push, or modify unrelated branches.
- Do NOT delete the remote branch.
- Use only the developer's existing local GitHub CLI authentication. If \`gh\` is missing, unauthenticated, or the remote is not GitHub-compatible, report a failure.

## Required Output

Return EXACTLY one JSON object as the final line of your output and nothing after it:

\`\`\`json
{"done": true, "prUrl": "https://github.com/owner/repo/pull/123", "summary": "one-line summary of the pull request"}
\`\`\`

On failure, return:

\`\`\`json
{"done": false, "reason": "why the pull request could not be created"}
\`\`\`
`;
}

function buildTemplateSection(template: GithubPrTemplateDiscoveryResult): string {
  if (template.kind === 'selected') {
    return `## Pull Request Template

Use the template at \`${template.path}\` for the pull request body:

\`\`\`markdown
${template.content}
\`\`\``;
  }
  if (template.kind === 'multiple') {
    return `## Pull Request Templates

Multiple pull request templates were found. Choose the most appropriate one for this feature:

${template.candidatePaths.map((candidatePath) => `- ${candidatePath}`).join('\n')}`;
  }
  return `## Pull Request Template

No pull request template was found. Write a clear, conventional pull request body summarizing the completed work.`;
}
