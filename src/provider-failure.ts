export type ProviderFailureKind =
  | 'model-unavailable'
  | 'auth'
  | 'context-overflow'
  | 'path-not-found'
  | 'patch-context-mismatch'
  | 'dependency-missing'
  | 'tool-failed'
  | 'unknown';

export interface ProviderFailureClassification {
  kind: ProviderFailureKind;
  reason: string;
  availableModels: string[];
}

export function classifyProviderFailure(reason: string | null | undefined): ProviderFailureClassification | null {
  const normalizedReason = reason?.trim();
  if (!normalizedReason) return null;
  const lower = normalizedReason.toLowerCase();

  if (lower.includes('model_not_available_for_integrator') || lower.includes('requested model is not available')) {
    return { kind: 'model-unavailable', reason: normalizedReason, availableModels: parseAvailableModels(normalizedReason) };
  }
  if (lower.includes('providerautherror') || lower.includes('authentication') || lower.includes('unauthorized')) {
    return { kind: 'auth', reason: normalizedReason, availableModels: [] };
  }
  if (lower.includes('context overflow')) return { kind: 'context-overflow', reason: normalizedReason, availableModels: [] };
  if (isDependencyMissing(lower)) return { kind: 'dependency-missing', reason: normalizedReason, availableModels: [] };
  if (isPatchContextMismatch(lower)) return { kind: 'patch-context-mismatch', reason: normalizedReason, availableModels: [] };
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

function isDependencyMissing(reason: string): boolean {
  return (
    reason.includes('vendor/autoload.php') ||
    reason.includes('cannot find module') ||
    reason.includes('module not found') ||
    reason.includes('missing dependency')
  );
}
