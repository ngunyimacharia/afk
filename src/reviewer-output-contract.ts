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
  done: boolean;
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
  const payloads = parsePayloads(input);

  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const review = normalizeReviewerPayload(payloads[index], raw);
    if (review) return review;
  }

  return fallbackParsedOutput(raw);
}

function normalizeReviewerPayload(parsed: Record<string, unknown>, raw: string): ParsedReviewerOutput | null {
  const findingsPayload = Array.isArray(parsed.findings)
    ? parsed.findings
    : Array.isArray(parsed.issues)
      ? parsed.issues
      : Array.isArray(parsed.problems)
        ? parsed.problems
        : Array.isArray(parsed.comments)
          ? parsed.comments
          : null;
  const summary = normalizeText(parsed.summary) || (findingsPayload ? 'Reviewer findings parsed.' : '');

  // done must be a boolean
  if (typeof parsed.done !== 'boolean') {
    return null;
  }

  const done = parsed.done;

  // If done is true but there are findings, this is inconsistent - treat as malformed
  if (done && findingsPayload && findingsPayload.length > 0) {
    return null;
  }

  // If there are no findings payload at all, treat as empty findings array
  if (!findingsPayload) {
    return {
      summary,
      findings: [],
      highestSeverity: 'minor',
      fallback: false,
      done,
      raw,
    };
  }

  const findings = findingsPayload.map(normalizeFinding);
  if (findings.some((finding) => finding === undefined)) {
    return null;
  }

  const normalizedFindings = findings as ReviewerFinding[];
  return {
    summary,
    findings: normalizedFindings,
    highestSeverity: highestSeverityFromFindings(normalizedFindings),
    fallback: false,
    done,
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

  // Approval only when reviewer explicitly says done:true AND there are no findings.
  // If reviewer says done:false with no findings, hand off instead of looping without actionable work.
  const decision: ReviewDecision =
    review.done && review.findings.length === 0
      ? 'approve'
      : !review.done && review.findings.length === 0
        ? 'needs-human'
        : cycle >= maxCycles
          ? 'needs-human'
          : 'loop';

  const reason =
    decision === 'approve'
      ? 'Reviewer confirmed ticket is complete'
      : decision === 'needs-human' && !review.done && review.findings.length === 0
        ? 'Reviewer output had no actionable findings'
        : decision === 'needs-human'
          ? 'Reviewer cycle cap reached with unresolved findings'
          : review.fallback
            ? 'Reviewer output was malformed and requires a retry'
            : 'Reviewer findings require fixup';

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

function parsePayloads(input: unknown): Record<string, unknown>[] {
  if (input && typeof input === 'object' && !Array.isArray(input)) return [input as Record<string, unknown>];
  if (
    Array.isArray(input) &&
    input.length === 1 &&
    input[0] &&
    typeof input[0] === 'object' &&
    !Array.isArray(input[0])
  )
    return [input[0] as Record<string, unknown>];
  if (typeof input !== 'string') return [];

  const payloads: Record<string, unknown>[] = [];
  for (const source of extractJsonCandidates(input)) {
    try {
      const value = JSON.parse(source) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) payloads.push(value as Record<string, unknown>);
      if (
        Array.isArray(value) &&
        value.length === 1 &&
        value[0] &&
        typeof value[0] === 'object' &&
        !Array.isArray(value[0])
      )
        payloads.push(value[0] as Record<string, unknown>);
    } catch {}
  }

  return payloads;
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(raw.trim());
  candidates.push(...findEmbeddedJsonObjects(raw));
  candidates.push(...findStandaloneJsonLines(raw));
  return candidates.filter(Boolean);
}

function findStandaloneJsonLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
}

function findEmbeddedJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!char) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) objects.push(raw.slice(start, index + 1).trim());
    }
  }

  return objects;
}

function normalizeFinding(value: unknown): ReviewerFinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const severity = normalizeReviewerSeverity(record.severity);
  if (!severity) return undefined;

  return {
    severity,
    title:
      normalizeText(record.title) ||
      normalizeText(record.summary) ||
      normalizeText(record.message) ||
      normalizeText(record.finding),
    detail:
      normalizeText(record.detail) ||
      normalizeText(record.description) ||
      normalizeText(record.body) ||
      normalizeText(record.message),
    ...(normalizeText(record.suggested_fix ?? record.suggestedFix)
      ? { suggestedFix: normalizeText(record.suggested_fix ?? record.suggestedFix) }
      : {}),
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
    done: false,
    raw,
  };
}
