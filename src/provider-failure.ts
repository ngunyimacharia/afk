import type { ProviderFailureSource } from './types.js';

export type ProviderFailureKind =
  | 'model-unavailable'
  | 'auth'
  | 'context-overflow'
  | 'rate-limit'
  | 'path-not-found'
  | 'patch-context-mismatch'
  | 'dependency-missing'
  | 'opencode-session-stale'
  | 'claude-session-stale'
  | 'codex-session-stale'
  | 'tool-failed'
  | 'unknown';

export interface ProviderFailureClassification {
  kind: ProviderFailureKind;
  reason: string;
  availableModels: string[];
  source?: ProviderFailureSource;
  matchedEvidence?: string;
}

const DETERMINISTIC_FAILURE_KINDS: Set<ProviderFailureKind> = new Set([
  'model-unavailable',
  'auth',
  'context-overflow',
  'rate-limit',
  'path-not-found',
  'patch-context-mismatch',
  'dependency-missing',
  'opencode-session-stale',
  'claude-session-stale',
  'codex-session-stale',
]);

export function isDeterministicFailureKind(kind: ProviderFailureKind): boolean {
  return DETERMINISTIC_FAILURE_KINDS.has(kind);
}

export function classifyProviderFailureFromSource(
  reason: string | null | undefined,
  source: ProviderFailureSource = 'unknown',
): ProviderFailureClassification | null {
  const normalizedReason = reason?.trim();
  if (!normalizedReason) return null;

  // For unstructured sources (agent-output, unknown), require higher-confidence signals.
  // Only classify when the source is a structured provider/runtime error.
  if (source === 'agent-output' || source === 'unknown') {
    // Only classify if the reason starts with a known provider error prefix
    // or contains a very specific structured marker.
    const lower = normalizedReason.toLowerCase();
    const hasStructuredPrefix =
      lower.startsWith('providerautherror') ||
      lower.startsWith('opencode error:') ||
      lower.startsWith('claude error:') ||
      lower.startsWith('codex error:') ||
      lower.startsWith('tool failed:') ||
      lower.startsWith('the requested model is not available');
    if (!hasStructuredPrefix) {
      return { kind: 'unknown', reason: normalizedReason, availableModels: [], source, matchedEvidence: undefined };
    }
  }

  const classification = classifyProviderFailure(normalizedReason);
  return { ...classification, source, matchedEvidence: classification.reason };
}

export function classifyProviderFailure(reason: string | null | undefined): ProviderFailureClassification {
  const normalizedReason = reason?.trim();
  if (!normalizedReason) return { kind: 'unknown', reason: '', availableModels: [] };
  const lower = normalizedReason.toLowerCase();

  if (lower.includes('model_not_available_for_integrator') || lower.includes('requested model is not available')) {
    return {
      kind: 'model-unavailable',
      reason: normalizedReason,
      availableModels: parseAvailableModels(normalizedReason),
    };
  }
  if (lower.includes('providerautherror') || lower.includes('authentication') || lower.includes('unauthorized')) {
    return { kind: 'auth', reason: normalizedReason, availableModels: [] };
  }
  if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('too many requests'))
    return { kind: 'rate-limit', reason: normalizedReason, availableModels: [] };
  if (lower.includes('context overflow'))
    return { kind: 'context-overflow', reason: normalizedReason, availableModels: [] };
  if (lower.includes('opencode session stale'))
    return { kind: 'opencode-session-stale', reason: normalizedReason, availableModels: [] };
  if (lower.includes('claude session stale'))
    return { kind: 'claude-session-stale', reason: normalizedReason, availableModels: [] };
  if (lower.includes('codex session stale'))
    return { kind: 'codex-session-stale', reason: normalizedReason, availableModels: [] };
  if (isDependencyMissing(lower)) return { kind: 'dependency-missing', reason: normalizedReason, availableModels: [] };
  if (isPatchContextMismatch(lower))
    return { kind: 'patch-context-mismatch', reason: normalizedReason, availableModels: [] };
  if (isPathNotFound(lower)) return { kind: 'path-not-found', reason: normalizedReason, availableModels: [] };
  if (lower.includes('tool failed:')) return { kind: 'tool-failed', reason: normalizedReason, availableModels: [] };

  return { kind: 'unknown', reason: normalizedReason, availableModels: [] };
}

export function formatProviderFailureMessage(input: {
  modelId: string;
  mode: 'execution' | 'reviewer';
  reason: string;
}): string {
  const classification = classifyProviderFailure(input.reason);
  if (classification?.kind === 'model-unavailable') {
    const label = input.mode === 'reviewer' ? 'reviewer model' : 'implementation model';
    return `provider failure: selected ${label} ${input.modelId} is unavailable`;
  }
  return `provider failure: ${input.reason}`;
}

function parseAvailableModels(reason: string): string[] {
  const match = reason.match(/Available models:\s*\[([^\]]+)\]/i);
  if (!match) return [];
  return match[1]
    .split(/\s+/)
    .map((model) => model.trim().replace(/^['"]|['",]$/g, ''))
    .filter(Boolean);
}

function isPathNotFound(reason: string): boolean {
  return (
    reason.includes('no such file or directory') ||
    reason.includes('enoent') ||
    reason.includes('file not found') ||
    reason.includes('path does not exist')
  );
}

function isPatchContextMismatch(reason: string): boolean {
  return (
    reason.includes('patch does not apply') ||
    reason.includes('hunk failed') ||
    reason.includes('context mismatch') ||
    reason.includes('apply_patch verification failed')
  );
}

export function detectClaudeCodeFailure(output: string[]): string | null {
  const failure = output.find((line) => {
    const normalized = line.toLowerCase();
    return (
      normalized.includes('claude error:') ||
      normalized.includes('claude agent error:') ||
      normalized.includes('session stale') ||
      normalized.includes('overloaded_error') ||
      normalized.includes('rate_limit_error') ||
      normalized.includes('context overflow')
    );
  });
  return failure ?? null;
}

export function detectCodexFailure(output: string[]): string | null {
  const failure = output.find((line) => {
    const normalized = line.toLowerCase();
    return (
      normalized.includes('codex error:') ||
      normalized.includes('requested model is not available') ||
      normalized.includes('authentication') ||
      normalized.includes('unauthorized') ||
      normalized.includes('rate limit') ||
      normalized.includes('rate_limit') ||
      normalized.includes('context overflow') ||
      normalized.includes('codex session stale')
    );
  });
  return failure ?? null;
}

function isDependencyMissing(reason: string): boolean {
  return (
    reason.includes('vendor/autoload.php') ||
    reason.includes('cannot find module') ||
    reason.includes('module not found') ||
    reason.includes('missing dependency')
  );
}
