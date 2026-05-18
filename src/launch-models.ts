import type { LaunchModel } from './types.js';

export interface LaunchModelSelection {
  executionModel: LaunchModel;
  reviewerModel: LaunchModel;
}

export interface LaunchModelSelectionInput {
  executionModelId?: string;
  reviewerModelId?: string;
}

function normalizeModelId(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function resolveLaunchModelSelection(input: LaunchModelSelectionInput = {}): LaunchModelSelection {
  return {
    executionModel: { id: normalizeModelId(input.executionModelId, 'default-model') },
    reviewerModel: { id: normalizeModelId(input.reviewerModelId, 'reviewer-default-model') },
  };
}
