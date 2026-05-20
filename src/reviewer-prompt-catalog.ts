import { statSync } from 'node:fs';
import path from 'node:path';
import type { ReviewerPromptTemplate } from './types.js';

export const DEFAULT_REVIEWER_PROMPT_ID = 'reviewer-default';
const BUILTIN_REVIEWER_PROMPT_PATH = 'builtin:reviewer-default';

const DEFAULT_REVIEWER_PROMPT = `# Reviewer Prompt

Review the completed ticket in read-only mode. Return only concrete issues that justify sending the work back.

## Rules

1. Do not modify files, git state, dependencies, generated artifacts, or \`.scratch/\`.
2. Review the ticket requirements, changed files, relevant surrounding code, and test evidence.
3. Focus on correctness, regressions, security, data loss, unmet requirements, missing tests, and maintainability risks for this ticket.
4. Keep scope discipline. Do not require unrelated refactors or speculative improvements.
5. Anchor every finding to specific evidence.

## Severity

Severity values: \`blocker\` for data loss/security/core workflow breakage; \`major\` for unmet requirements or likely regressions; \`minor\` for non-blocking risks.

## Output Format

Return strict JSON only. Do not include markdown fences, headings, bullets, prose, or any text before/after the JSON object.

Required schema: {"summary":"string","findings":[{"severity":"minor|major|blocker","title":"string","detail":"string","suggestedFix":"string optional"}]}

Clean pass example: {"summary":"Reviewed implementation and tests; no material issues found.","findings":[]}

Finding example: {"summary":"Blocking issues found.","findings":[{"severity":"major","title":"Acceptance criterion unmet","detail":"Specific evidence-backed issue."}]}
`;

const CATALOG: Record<string, ReviewerPromptTemplate> = {
  [DEFAULT_REVIEWER_PROMPT_ID]: {
    id: DEFAULT_REVIEWER_PROMPT_ID,
    label: 'Reviewer default',
    path: BUILTIN_REVIEWER_PROMPT_PATH,
    content: DEFAULT_REVIEWER_PROMPT,
  },
};

function fileExists(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

export function resolveReviewerPromptTemplate(): ReviewerPromptTemplate {
  return CATALOG[DEFAULT_REVIEWER_PROMPT_ID];
}

export function resolveReviewerPrompt(input: { repoRoot: string; override?: string }): ReviewerPromptTemplate {
  const override = input.override?.trim();
  if (!override) {
    return resolveReviewerPromptTemplate();
  }

  const catalogResolved = CATALOG[override];
  if (catalogResolved) return catalogResolved;

  const resolvedPath = path.isAbsolute(override) ? override : path.join(input.repoRoot, override);
  if (!fileExists(resolvedPath)) throw new Error(`Reviewer prompt not found: ${override}`);
  return { id: override, label: override, path: resolvedPath };
}
