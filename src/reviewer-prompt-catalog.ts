import type { ReviewerPromptTemplate } from './types.js';

const REVIEWER_PROMPT_TEMPLATE: ReviewerPromptTemplate = {
  id: 'reviewer-default',
  label: 'Reviewer default',
  path: 'src/prompts/reviewer-default.md',
};

export function resolveReviewerPromptTemplate(): ReviewerPromptTemplate {
  return REVIEWER_PROMPT_TEMPLATE;
}
