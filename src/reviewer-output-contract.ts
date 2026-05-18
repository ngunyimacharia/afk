export const REVIEWER_SEVERITIES = ['minor', 'major', 'blocker'] as const;

export type ReviewerSeverity = (typeof REVIEWER_SEVERITIES)[number];
export type ReviewDecision = 'approve' | 'loop' | 'needs-human';

export interface ReviewerFinding {
  severity: ReviewerSeverity;
  title: string;
  detail: string;
  suggestedFix?: string;
}

export interface ParsedReviewerOutput {
  summary: string;
  findings: ReviewerFinding[];
  highestSeverity: ReviewerSeverity;
  fallback: boolean;
  raw: string;
}

export interface ReviewDecisionResult {
  decision: ReviewDecision;
  highestSeverity: ReviewerSeverity;
  cycle: number;
  maxCycles: number;
  fallback: boolean;
}

const SEVERITY_RANK: Record<ReviewerSeverity, number> = {
  minor: 0,
  major: 1,
  blocker: 2,
};

export function normalizeReviewerSeverity(value: unknown): ReviewerSeverity | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'minor') return 'minor';
  if (normalized === 'major') return 'major';
  if (normalized === 'blocker') return 'blocker';
  return undefined;
}

export function parseReviewerOutput(input: unknown): ParsedReviewerOutput {
  const raw = stringifyRaw(input);
  const parsed = parsePayload(input);
  if (!parsed) {
    return fallbackParsedOutput(raw);
  }

  const summary = normalizeText(parsed.summary);
  if (!Array.isArray(parsed.findings)) {
    return fallbackParsedOutput(raw);
  }

  const findings = parsed.findings.map(normalizeFinding);
  if (findings.some((finding) => finding === undefined)) {
    return fallbackParsedOutput(raw);
  }

  const normalizedFindings = findings as ReviewerFinding[];
  return {
    summary,
    findings: normalizedFindings,
    highestSeverity: highestSeverityFromFindings(normalizedFindings),
    fallback: false,
    raw,
  };
}

export function decideReviewOutcome(
  review: ParsedReviewerOutput,
  options: { cycle: number; maxCycles?: number },
): ReviewDecisionResult {
  const cycle = normalizePositiveInteger(options.cycle, 1);
  const maxCycles = normalizePositiveInteger(options.maxCycles ?? 3, 3);
  const highestSeverity = review.highestSeverity;
  const decision: ReviewDecision = highestSeverity === 'minor' ? 'approve' : cycle >= maxCycles ? 'needs-human' : 'loop';

  return {
    decision,
    highestSeverity,
    cycle,
    maxCycles,
    fallback: review.fallback,
  };
}

function parsePayload(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== 'string') return null;

  const source = extractJsonSource(input);
  try {
    const value = JSON.parse(source) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function extractJsonSource(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fence?.[1] ?? raw).trim();
}

function normalizeFinding(value: unknown): ReviewerFinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const severity = normalizeReviewerSeverity(record.severity);
  if (!severity) return undefined;

  return {
    severity,
    title: normalizeText(record.title),
    detail: normalizeText(record.detail),
    ...(normalizeText(record.suggested_fix ?? record.suggestedFix) ? { suggestedFix: normalizeText(record.suggested_fix ?? record.suggestedFix) } : {}),
  };
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringifyRaw(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? '');
  } catch {
    return '';
  }
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function highestSeverityFromFindings(findings: ReviewerFinding[]): ReviewerSeverity {
  return findings.reduce<ReviewerSeverity>((current, finding) => {
    return SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current] ? finding.severity : current;
  }, 'minor');
}

function fallbackParsedOutput(raw: string): ParsedReviewerOutput {
  const fallbackFinding: ReviewerFinding = {
    severity: 'major',
    title: 'Malformed reviewer output',
    detail: raw.trim() || 'Reviewer output could not be parsed into the expected contract.',
  };

  return {
    summary: 'Malformed reviewer output',
    findings: [fallbackFinding],
    highestSeverity: 'major',
    fallback: true,
    raw,
  };
}
