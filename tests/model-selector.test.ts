import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLaunchPlan } from '../src/launch-context-builder.js';
import { ModelSelector } from '../src/model-selector.js';

test('selects model', async () => {
  const selector = new ModelSelector(
    async () => [{ id: 'm1' }],
    async (models) => models[0],
  );
  assert.equal((await selector.selectModel()).id, 'm1');
});

test('fails when cancelled', async () => {
  const selector = new ModelSelector(
    async () => [{ id: 'm1' }],
    async () => null,
  );
  await assert.rejects(() => selector.selectModel(), /No model selected/);
});

test('keeps execution and reviewer selections independent', async () => {
  const selector = new ModelSelector(
    async () => [{ id: 'exec' }, { id: 'review' }],
    async (models) => models[1],
  );
  assert.equal((await selector.selectModel()).id, 'review');
});

test('builds launch plans with reviewer model and prompt context', () => {
  const plan = buildLaunchPlan(
    '/repo',
    { id: 'exec-model' },
    [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true }],
    {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/repo/.git/worktrees/feat',
    },
    {
      model: { id: 'review-model' },
      prompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
    },
  );

  assert.equal(plan.model.id, 'exec-model');
  assert.equal(plan.reviewerModel?.id, 'review-model');
  assert.equal(plan.reviewerPrompt?.id, 'reviewer-default');
});
