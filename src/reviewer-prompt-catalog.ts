import { statSync } from 'node:fs';
import path from 'node:path';
import type { ReviewerPromptTemplate } from './types.js';

export const DEFAULT_REVIEWER_PROMPT_ID = 'reviewer-default';

const REVIEWER_PROMPT_TEMPLATE: ReviewerPromptTemplate = {
  id: DEFAULT_REVIEWER_PROMPT_ID,
  label: 'Reviewer default',
  path: 'src/prompts/reviewer-default.md',
};

const CATALOG: Record<string, string> = {
  [DEFAULT_REVIEWER_PROMPT_ID]: path.join('src', 'prompts', 'reviewer-default.md'),
};

function fileExists(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function catalogPath(repoRoot: string, id: string): string | undefined {
  const relativePath = CATALOG[id];
  return relativePath ? path.join(repoRoot, relativePath) : undefined;
}

export function resolveReviewerPromptTemplate(): ReviewerPromptTemplate {
  return REVIEWER_PROMPT_TEMPLATE;
}

export function resolveReviewerPrompt(input: { repoRoot: string; override?: string }): ReviewerPromptTemplate {
  const override = input.override?.trim();
  if (!override) {
    const defaultPath = catalogPath(input.repoRoot, DEFAULT_REVIEWER_PROMPT_ID) ?? path.join(input.repoRoot, 'src', 'prompts', 'reviewer-default.md');
    if (!fileExists(defaultPath)) throw new Error(`Reviewer prompt not found: ${DEFAULT_REVIEWER_PROMPT_ID}`);
    return { id: DEFAULT_REVIEWER_PROMPT_ID, label: 'Reviewer default', path: defaultPath };
  }

  const catalogResolvedPath = catalogPath(input.repoRoot, override);
  if (catalogResolvedPath) {
    if (!fileExists(catalogResolvedPath)) throw new Error(`Reviewer prompt not found: ${override}`);
    return { id: override, label: override, path: catalogResolvedPath };
  }

  const resolvedPath = path.isAbsolute(override) ? override : path.join(input.repoRoot, override);
  if (!fileExists(resolvedPath)) throw new Error(`Reviewer prompt not found: ${override}`);
  return { id: override, label: override, path: resolvedPath };
}
