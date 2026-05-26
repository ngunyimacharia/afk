import { statSync } from 'node:fs';
import path from 'node:path';
import type { ReviewerPromptTemplate } from './types.js';

export const DEFAULT_REVIEWER_PROMPT_ID = 'reviewer-default';
export const LIGHTWEIGHT_REVIEWER_PROMPT_ID = 'reviewer-lightweight';
export const CONFLICT_RESOLUTION_PROMPT_ID = 'reviewer-conflict-resolution';
const BUILTIN_REVIEWER_PROMPT_PATH = 'builtin:reviewer-default';
const BUILTIN_LIGHTWEIGHT_REVIEWER_PROMPT_PATH = 'builtin:reviewer-lightweight';
const BUILTIN_CONFLICT_RESOLUTION_PROMPT_PATH = 'builtin:reviewer-conflict-resolution';

const DEFAULT_REVIEWER_PROMPT = `# Reviewer Prompt

Review the completed ticket in read-only mode. Determine whether the implementation is complete and correct.

## Rules

1. Do not modify files, git state, dependencies, generated artifacts, or \`.scratch/\`.
2. Use the exact runtime paths provided in the Review Target section first. Review the ticket requirements, changed files, relevant surrounding code, and test evidence.
3. Avoid broad searches, recursive greps, or workspace-wide scans unless the exact paths are missing or inconsistent.
4. Focus on correctness, regressions, security, data loss, unmet requirements, missing tests, and maintainability risks for this ticket.
5. Keep scope discipline. Do not require unrelated refactors or speculative improvements.
6. Anchor every finding to specific evidence.
7. Use verification evidence from the ticket and AFK Summary when assessing completion and risk.

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

const CONFLICT_RESOLUTION_PROMPT = `# Conflict Resolution Prompt

You are resolving merge conflicts in a feature worktree. Two or more parallel ticket implementations produced overlapping changes. Your job is to inspect the conflict markers, understand the intent of each change, and synthesize the correct merged result.

## Rules

1. Operate only on files that currently contain git conflict markers. Do not modify unrelated files.
2. Read each conflicting file and understand what each side of the conflict is trying to do.
3. Produce a coherent merged version that preserves the intent of BOTH changes where possible.
4. If one change should clearly supersede the other, choose the stronger version and document your reasoning.
5. Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>). No conflict markers may remain.
6. After editing, verify the feature still compiles and tests pass.
7. Do NOT create new files, delete files, or change git state (branch, merge, push) except by editing file contents.
8. Do NOT modify \`.scratch/\` artifacts.

## Conflict Resolution Completion Criteria

Before returning \`done:true\`, you MUST verify ALL of the following:
1. No conflict markers remain in any file.
2. The merged code is syntactically valid and semantically coherent.
3. Smoke tests or static checks pass (run them if available).

If you cannot resolve the conflicts cleanly, return \`done:false\` and explain why.

## Output Format

You must return **exactly one JSON object** with no other text.

Rules:
- Do NOT wrap the output in markdown code fences (no \`\`\`json).
- Do NOT include any text before or after the JSON object.
- Do NOT split keys or values across multiple lines. The entire JSON must be a single continuous block of text.
- Every string must be on the same line as its surrounding quotes.

Required schema:
{"done":boolean,"summary":"string","conflictPaths":["string"],"findings":[{"severity":"minor|major|blocker","title":"string","detail":"string"}]}

Clean pass example:
{"done":true,"summary":"All conflicts resolved cleanly. Tests pass.","conflictPaths":[],"findings":[]}

Failure example:
{"done":false,"summary":"Unable to reconcile conflicting logic in src/core.ts.","conflictPaths":["src/core.ts"],"findings":[{"severity":"blocker","title":"Irreconcilable conflict","detail":"Both sides changed the same algorithm in incompatible ways."}]}
`;

const LIGHTWEIGHT_REVIEWER_PROMPT = `# Reviewer Prompt (Lightweight)

Review the completed ticket in read-only mode using a lightweight, deterministic scope. This is NOT a skip-review pass; it performs focused checks only.

## Rules

1. Do not modify files, git state, dependencies, generated artifacts, or \`.scratch/\`.
2. Use the exact runtime paths provided in the Review Target section first. Review the ticket requirements, changed files, and test evidence.
3. Avoid broad searches, recursive greps, or workspace-wide scans unless the exact paths are missing or inconsistent.
4. Keep scope discipline. Lightweight review checks the following deterministically and nothing more:
   - Ticket status is \`done\` and \`## AFK Summary\` is present.
   - Verification evidence exists (tests ran, build succeeded, or blockers were recorded).
   - No obvious blockers such as compilation errors, missing required files, or uncommitted source changes.
   - The implementation matches the ticket acceptance criteria at a surface level (files changed, behavior added/removed).
5. Do NOT perform deep architectural review, style critique, speculative maintainability analysis, or unrelated refactor recommendations.
6. Anchor every finding to specific evidence.

## Completion Criteria

Before returning \`done:true\`, you MUST verify ALL of the following:
1. The ticket file has YAML frontmatter with \`status: done\`.
2. The ticket file contains a \`## AFK Summary\` section.
3. Verification evidence is recorded in the AFK Summary or ticket file.
4. There are no obvious blockers.

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
{"done":true,"summary":"Lightweight review passed: ticket status is done, AFK Summary is present, verification evidence exists, no obvious blockers.","findings":[]}

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
  [LIGHTWEIGHT_REVIEWER_PROMPT_ID]: {
    id: LIGHTWEIGHT_REVIEWER_PROMPT_ID,
    label: 'Reviewer lightweight',
    path: BUILTIN_LIGHTWEIGHT_REVIEWER_PROMPT_PATH,
    content: LIGHTWEIGHT_REVIEWER_PROMPT,
  },
  [CONFLICT_RESOLUTION_PROMPT_ID]: {
    id: CONFLICT_RESOLUTION_PROMPT_ID,
    label: 'Reviewer conflict resolution',
    path: BUILTIN_CONFLICT_RESOLUTION_PROMPT_PATH,
    content: CONFLICT_RESOLUTION_PROMPT,
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
