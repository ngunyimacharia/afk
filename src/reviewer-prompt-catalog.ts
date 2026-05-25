import { statSync } from 'node:fs';
import path from 'node:path';
import type { ReviewerPromptTemplate } from './types.js';

export const DEFAULT_REVIEWER_PROMPT_ID = 'reviewer-default';
const BUILTIN_REVIEWER_PROMPT_PATH = 'builtin:reviewer-default';

const DEFAULT_REVIEWER_PROMPT = `# Reviewer Prompt

Review the completed ticket in read-only mode. Determine whether the implementation is complete and correct.

## Rules

1. Do not modify files, git state, dependencies, generated artifacts, or \`.scratch/\`.
2. Review the ticket requirements, changed files, relevant surrounding code, and test evidence.
3. Focus on correctness, regressions, security, data loss, unmet requirements, missing tests, and maintainability risks for this ticket.
4. Keep scope discipline. Do not require unrelated refactors or speculative improvements.
5. Anchor every finding to specific evidence.

## Completion Criteria

Before returning \`done:true\`, you MUST verify ALL of the following:
1. The ticket file has YAML frontmatter with \`status: done\`.
2. The ticket file contains a \`## AFK Summary\` section.
3. There are no material issues (no findings).

If any of the above are not met, return \`done:false\` and include findings explaining what is missing or incorrect.

## Severity

Severity values: \`blocker\` for data loss/security/core workflow breakage; \`major\` for unmet requirements or likely regressions; \`minor\` for non-blocking risks.

## Output Format

You must return **exactly one JSON object** with no other text.

Rules:
- Do NOT wrap the output in markdown code fences (no \`\`\`json).
- Do NOT include any text before or after the JSON object.
- Do NOT split keys or values across multiple lines. The entire JSON must be a single continuous block of text.
- Every string must be on the same line as its surrounding quotes. Example: {"summary":"This is correct","findings":[]}
- Do NOT pretty-print, indent, or add newlines inside the JSON object.

Required schema:
{"done":boolean,"summary":"string","findings":[{"severity":"minor|major|blocker","title":"string","detail":"string","suggestedFix":"string optional"}]}

Clean pass example:
{"done":true,"summary":"Reviewed implementation and tests; ticket status is done, AFK Summary is present, no material issues found.","findings":[]}

Finding example:
{"done":false,"summary":"Blocking issues found.","findings":[{"severity":"major","title":"Acceptance criterion unmet","detail":"Specific evidence-backed issue."}]}

If you have no findings but the ticket is not complete (missing status: done or missing AFK Summary), output:
{"done":false,"summary":"Ticket incomplete: [explain what is missing]","findings":[]}
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
