import { statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_REVIEWER_PROMPT_ID = 'reviewer-default';

export interface ReviewerPromptReference {
  id: string;
  path: string;
}

export interface ReviewerPromptCatalogInput {
  repoRoot: string;
  override?: string;
}

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

export function resolveReviewerPrompt(input: ReviewerPromptCatalogInput): ReviewerPromptReference {
  const override = input.override?.trim();
  if (!override) {
    const defaultPath = catalogPath(input.repoRoot, DEFAULT_REVIEWER_PROMPT_ID) ?? path.join(input.repoRoot, 'src', 'prompts', 'reviewer-default.md');
    if (!fileExists(defaultPath)) throw new Error(`Reviewer prompt not found: ${DEFAULT_REVIEWER_PROMPT_ID}`);
    return { id: DEFAULT_REVIEWER_PROMPT_ID, path: defaultPath };
  }

  const catalogResolvedPath = catalogPath(input.repoRoot, override);
  if (catalogResolvedPath) {
    if (!fileExists(catalogResolvedPath)) throw new Error(`Reviewer prompt not found: ${override}`);
    return { id: override, path: catalogResolvedPath };
  }

  const resolvedPath = path.isAbsolute(override) ? override : path.join(input.repoRoot, override);
  if (!fileExists(resolvedPath)) throw new Error(`Reviewer prompt not found: ${override}`);
  return { id: override, path: resolvedPath };
}
