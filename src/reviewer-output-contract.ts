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
  failureKind?: 'malformed-output';
  raw: string;
}

export interface ReviewDecisionResult {
  decision: ReviewDecision;
  highestSeverity: ReviewerSeverity;
  cycle: number;
  maxCycles: number;
  fallback: boolean;
  reason: string;
  findings: ReviewerFinding[];
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
  const reason = decision === 'approve'
    ? 'Reviewer findings are minor only'
    : decision === 'needs-human'
      ? 'Reviewer cycle cap reached with unresolved major findings'
      : review.fallback
        ? 'Reviewer output was malformed and requires a retry'
        : 'Reviewer findings include major or blocker severity';

  return {
    decision,
    highestSeverity,
    cycle,
    maxCycles,
    fallback: review.fallback,
    reason,
    findings: review.findings,
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
    title: normalizeText(record.title) || normalizeText(record.summary) || normalizeText(record.message) || normalizeText(record.finding),
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
  return {
    summary: 'Malformed reviewer output',
    findings: [],
    highestSeverity: 'major',
    fallback: true,
    failureKind: 'malformed-output',
    raw,
  };
}
