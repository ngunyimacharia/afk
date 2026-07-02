import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SelectableHarnessId } from './harness-registry.js';
import { resolveSandcastleAgentProvider } from './sandcastle-provider.js';
import type {
  AfkStateSnapshot,
  DependencySnapshot,
  LaunchModel,
  LaunchPlan,
  ReadinessSnapshot,
  ReviewerPromptTemplate,
  SandboxMode,
  TicketRecord,
} from './types.js';
import type { PreparedCheckoutContext } from './worktree-preparation-service.js';
import { runGit } from './worktree-preparation-service.js';

function ticketStatus(ticket?: TicketRecord): string {
  return ticket?.status?.trim() || 'unknown';
}

function readRuntimeStatus(repoRoot: string, feature: string, issueName: string): string {
  try {
    const metadataPath = path.join(
      repoRoot,
      '.scratch',
      '.opencode-afk-logs',
      'runtime-metadata',
      `${feature}-${issueName}.json`,
    );
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    return typeof parsed.STATUS === 'string' && parsed.STATUS.trim()
      ? parsed.STATUS
      : 'unknown (metadata missing status)';
  } catch {
    return 'unknown (metadata missing)';
  }
}

function sentinelState(
  repoRoot: string,
  feature: string,
  issueName: string,
  kind: 'done' | 'failed',
): 'present' | 'missing' {
  const target = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', `${feature}-${issueName}.${kind}`);
  return existsSync(target) ? 'present' : 'missing';
}

function readReadinessSummary(repoRoot: string, feature: string): ReadinessSnapshot | null {
  const candidates = [
    path.join(repoRoot, '.scratch', feature, 'launcher-state-summary.json'),
    path.join(repoRoot, '.scratch', feature, 'state-summary.json'),
    path.join(repoRoot, '.scratch', feature, 'worktree-readiness.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      return {
        sourcePath: candidate,
        dependencyCopy: stringifyReadinessField(parsed.dependencyCopyResult ?? parsed.dependencyCopy),
        envTesting: stringifyReadinessField(parsed.envTestingStatus ?? parsed.envTesting),
        disabledTests: stringifyReadinessField(parsed.disabledTestDecision ?? parsed.disabledTests),
        smokeTest: stringifyReadinessField(parsed.smokeTestResult ?? parsed.smokeTest),
        staticReadiness: stringifyReadinessField(parsed.staticReadiness ?? parsed.staticStatus),
        styleReadiness: stringifyReadinessField(parsed.styleReadiness ?? parsed.styleStatus),
      };
    } catch {
      return {
        sourcePath: candidate,
        dependencyCopy: 'unknown (state summary unreadable)',
        envTesting: 'unknown (state summary unreadable)',
        disabledTests: 'unknown (state summary unreadable)',
        smokeTest: 'unknown (state summary unreadable)',
        staticReadiness: 'unknown (state summary unreadable)',
        styleReadiness: 'unknown (state summary unreadable)',
      };
    }
  }
  return null;
}

function stringifyReadinessField(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return 'unknown (state summary missing field)';
}

function buildDependencySnapshots(
  repoRoot: string,
  ticket: TicketRecord,
  tickets: TicketRecord[],
): DependencySnapshot[] {
  return (ticket.dependsOn ?? []).map((dependencyIssue) => {
    const dependencyLabel = normalizeDependencyLabel(ticket.feature, dependencyIssue);
    const dependencyIssueName = dependencyLabel.slice(dependencyLabel.indexOf('/') + 1);
    const dependencyTicket = tickets.find((entry) => `${entry.feature}/${entry.issueName}` === dependencyLabel);
    return {
      label: dependencyLabel,
      issueName: dependencyIssueName,
      status: ticketStatus(dependencyTicket),
      doneSentinel: sentinelState(repoRoot, ticket.feature, dependencyIssueName, 'done'),
      failedSentinel: sentinelState(repoRoot, ticket.feature, dependencyIssueName, 'failed'),
      runtimeStatus: readRuntimeStatus(repoRoot, ticket.feature, dependencyIssueName),
    };
  });
}

function normalizeDependencyLabel(feature: string, dependency: string): string {
  return dependency.includes('/') ? dependency : `${feature}/${dependency}`;
}

function buildSnapshot(
  repoRoot: string,
  ticket: TicketRecord,
  tickets: TicketRecord[],
  checkout: PreparedCheckoutContext,
): AfkStateSnapshot {
  const generatedAt = new Date().toISOString();
  const repoRootResolved = path.resolve(repoRoot);
  const worktreePath = path.resolve(checkout.worktreePath);
  const ticketPath = path.resolve(ticket.path);
  const scratchFeaturePath = path.join(repoRootResolved, '.scratch', ticket.feature);
  const featurePrdPath = path.join(scratchFeaturePath, 'PRD.md');
  const head = (() => {
    try {
      return runGit(checkout.worktreePath, ['rev-parse', 'HEAD']);
    } catch {
      return 'unknown';
    }
  })();
  const gitStatusShort = (() => {
    try {
      const output = runGit(checkout.worktreePath, ['status', '--short']);
      return output ? output.split('\n').filter(Boolean) : [];
    } catch {
      return ['unknown (git status unavailable)'];
    }
  })();
  return {
    generatedAt,
    ticketLabel: ticket.label,
    ticketStatus: ticketStatus(ticket),
    ticketIssueName: ticket.issueName,
    featureSlug: ticket.feature,
    ticketPath,
    scratchFeaturePath,
    ...(existsSync(featurePrdPath) ? { featurePrdPath } : {}),
    repoRoot: repoRootResolved,
    worktreePath,
    worktreeName: checkout.effectiveWorktreeName,
    branchName: checkout.effectiveBranchName,
    head,
    gitStatusShort,
    ticketOutsideWorktree: path.relative(worktreePath, ticketPath).startsWith('..'),
    ...(ticket.providerIdentity ? { providerIdentity: ticket.providerIdentity } : {}),
    ...(ticket.providerIdentity?.mirrorPath ? { mirrorPath: ticket.providerIdentity.mirrorPath } : {}),
    dependencies: buildDependencySnapshots(repoRootResolved, ticket, tickets),
    readiness: readReadinessSummary(repoRootResolved, ticket.feature),
  };
}

export function buildLaunchPlan(
  repoRoot: string,
  model: LaunchModel,
  tickets: TicketRecord[],
  checkout: PreparedCheckoutContext,
  reviewer?: {
    harness?: SelectableHarnessId;
    model?: LaunchModel;
    prompt?: ReviewerPromptTemplate;
  },
  checkoutsByFeature?: Record<string, PreparedCheckoutContext>,
  featureDependencies?: Record<string, string[]>,
  harness?: SelectableHarnessId,
  sandboxMode?: SandboxMode,
): LaunchPlan {
  const snapshots = Object.fromEntries(
    tickets.map((ticket) => [
      ticket.label,
      buildSnapshot(repoRoot, ticket, tickets, checkoutsByFeature?.[ticket.feature] ?? checkout),
    ]),
  );
  return {
    repoRoot,
    harness,
    sandboxMode,
    model,
    ...(harness ? { sandcastleProvider: resolveSandcastleAgentProvider(harness, model) } : {}),
    reviewerHarness: reviewer?.harness,
    reviewerModel: reviewer?.model,
    ...(reviewer?.harness
      ? { reviewerSandcastleProvider: resolveSandcastleAgentProvider(reviewer.harness, reviewer.model) }
      : {}),
    reviewerPrompt: reviewer?.prompt,
    tickets,
    checkout,
    checkouts: checkoutsByFeature,
    ticketCheckouts: {},
    snapshots,
    gitContext: { commits: [] },
    featureDependencies,
  };
}
