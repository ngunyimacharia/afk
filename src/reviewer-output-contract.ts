export type ReviewerSeverity = 'minor' | 'major' | 'blocker';

export interface ReviewerFinding {
  severity: ReviewerSeverity;
  summary: string;
  detail?: string;
  path?: string;
  line?: number;
}

export interface ReviewerOutputContract {
  summary: string;
  findings: ReviewerFinding[];
  malformed: boolean;
  raw: string;
}

export type ReviewerDecisionOutcome = 'approve' | 'loop-required' | 'handoff-required';

export interface ReviewerDecisionInput {
  review: ReviewerOutputContract;
  cycleCount: number;
  maxCycles: number;
}

export interface ReviewerDecision {
  outcome: ReviewerDecisionOutcome;
  reason: string;
  malformed: boolean;
  findings: ReviewerFinding[];
}

const REVIEWER_SEVERITIES: readonly ReviewerSeverity[] = ['minor', 'major', 'blocker'];

const FALLBACK_FINDING: ReviewerFinding = {
  severity: 'major',
  summary: 'Reviewer output could not be parsed',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractCodeFenceContent(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1]?.trim();
}

function parseJsonPayload(raw: string): unknown {
  const fenced = extractCodeFenceContent(raw);
  const candidate = fenced ?? raw.trim();
  return JSON.parse(candidate);
}

function normalizeSeverity(value: unknown): ReviewerSeverity | undefined {
  if (typeof value !== 'string') return undefined;
  const severity = value.trim().toLowerCase();
  return REVIEWER_SEVERITIES.includes(severity as ReviewerSeverity) ? (severity as ReviewerSeverity) : undefined;
}

function normalizeSummary(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeFinding(value: unknown): ReviewerFinding | undefined {
  if (typeof value === 'string') {
    const summary = value.trim();
    return summary ? { severity: 'major', summary } : undefined;
  }

  if (!isObject(value)) return undefined;

  const severity = normalizeSeverity(value.severity);
  const summary = normalizeSummary(value.summary) ?? normalizeSummary(value.message) ?? normalizeSummary(value.detail) ?? normalizeSummary(value.finding);

  if (!severity || !summary) return undefined;

  const finding: ReviewerFinding = { severity, summary };

  const detail = normalizeSummary(value.detail);
  if (detail && detail !== summary) finding.detail = detail;

  const pathValue = normalizeSummary(value.path);
  if (pathValue) finding.path = pathValue;

  const lineValue = typeof value.line === 'number' && Number.isInteger(value.line) && value.line > 0 ? value.line : undefined;
  if (lineValue !== undefined) finding.line = lineValue;

  return finding;
}

function buildMalformedOutput(raw: string): ReviewerOutputContract {
  return {
    summary: 'Malformed reviewer output',
    findings: [FALLBACK_FINDING],
    malformed: true,
    raw,
  };
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input;

  try {
    const serialized = JSON.stringify(input);
    return serialized ?? String(input);
  } catch {
    return String(input);
  }
}

export function parseReviewerOutput(input: string | unknown): ReviewerOutputContract {
  const raw = stringifyInput(input);

  try {
    const parsed = typeof input === 'string' ? parseJsonPayload(input) : input;

    if (!isObject(parsed)) return buildMalformedOutput(raw);

    const summary = normalizeSummary(parsed.summary) ?? normalizeSummary(parsed.overallSummary) ?? normalizeSummary(parsed.message);
    const findingsSource = Array.isArray(parsed.findings) ? parsed.findings : Array.isArray(parsed.issues) ? parsed.issues : undefined;

    if (!summary || !findingsSource) return buildMalformedOutput(raw);

    const findings = findingsSource.map(normalizeFinding);
    if (findings.some((finding) => finding === undefined)) return buildMalformedOutput(raw);

    return {
      summary,
      findings: findings as ReviewerFinding[],
      malformed: false,
      raw,
    };
  } catch {
    return buildMalformedOutput(raw);
  }
}

export function decideReviewOutcome(input: ReviewerDecisionInput): ReviewerDecision {
  const hasMajorFinding = input.review.findings.some((finding) => finding.severity === 'major' || finding.severity === 'blocker');

  if (!hasMajorFinding) {
    return {
      outcome: 'approve',
      reason: 'Reviewer findings are minor only',
      malformed: input.review.malformed,
      findings: input.review.findings,
    };
  }

  if (input.cycleCount >= input.maxCycles) {
    return {
      outcome: 'handoff-required',
      reason: 'Reviewer cycle cap reached with unresolved major findings',
      malformed: input.review.malformed,
      findings: input.review.findings,
    };
  }

  return {
    outcome: 'loop-required',
    reason: input.review.malformed ? 'Reviewer output was malformed and requires a retry' : 'Reviewer findings include major or blocker severity',
    malformed: input.review.malformed,
    findings: input.review.findings,
  };
}
