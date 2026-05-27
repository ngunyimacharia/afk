import prompts from 'prompts';
import { resolveReviewerPromptTemplate } from './reviewer-prompt-catalog.js';
import type { LaunchModel, LaunchPreferences, ReviewerPromptTemplate, TicketRecord } from './types.js';

export interface PromptIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface LaunchWizardResult {
  cancelled: boolean;
  harness?: 'OpenCode' | 'Claude-Kimi';
  model?: LaunchModel;
  reviewerHarness?: 'OpenCode' | 'Claude-Kimi';
  reviewerModel?: LaunchModel;
  reviewerPrompt?: ReviewerPromptTemplate;
  tickets?: TicketRecord[];
  concurrency?: number;
  mergeBackToBase?: boolean;
}

export function isInteractiveLaunchAllowed(io: PromptIO, env: NodeJS.ProcessEnv): { ok: boolean; reason?: string } {
  if (env.CI) return { ok: false, reason: 'AFK launch requires an interactive TTY and does not run in CI.' };
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    return {
      ok: false,
      reason: 'AFK launch requires an interactive terminal (TTY). Run `afk` directly in a terminal.',
    };
  }
  return { ok: true };
}

export async function runInteractiveLaunchWizard(input: {
  io: PromptIO;
  repoRoot: string;
  availableHarnesses: string[];
  discoverModels: (harness: string) => Promise<LaunchModel[]>;
  tickets: TicketRecord[];
  preferences?: LaunchPreferences;
}): Promise<LaunchWizardResult> {
  const harnessChoices = input.availableHarnesses;
  if (harnessChoices.length === 0) {
    input.io.stdout.write('No harnesses available. Install and configure OpenCode or Claude.\n');
    return { cancelled: true };
  }

  const harnessInitial = input.preferences?.harness ? harnessChoices.indexOf(input.preferences.harness) : undefined;
  const harness = await promptSingleSelect(input.io, 'Select implementation harness', harnessChoices, harnessInitial);
  if (!harness) return { cancelled: true };

  const models = await input.discoverModels(harness);
  if (!models.length) {
    input.io.stdout.write(`No models available for ${harness}. Configure the provider and run \`afk\` again.\n`);
    return { cancelled: true };
  }

  const modelChoices = prioritizeModelChoices(models, input.preferences?.modelId);
  const selectedModelId = await promptSingleSelect(input.io, 'Select implementation model', modelChoices, 0);
  if (!selectedModelId) return { cancelled: true };
  const model = models.find((item) => item.id === selectedModelId);
  if (!model) return { cancelled: true };

  const reviewerHarnessChoices = harnessChoices.map((choice) =>
    choice === harness ? `${choice} (same as implementation)` : choice,
  );
  const reviewerHarnessInitial = input.preferences?.reviewerHarness
    ? harnessChoices.indexOf(input.preferences.reviewerHarness)
    : harnessChoices.indexOf(harness);
  const selectedReviewerHarnessDisplay = await promptSingleSelect(
    input.io,
    'Select reviewer harness',
    reviewerHarnessChoices,
    reviewerHarnessInitial >= 0 ? reviewerHarnessInitial : undefined,
  );
  if (!selectedReviewerHarnessDisplay) return { cancelled: true };
  const reviewerHarness = selectedReviewerHarnessDisplay.replace(/ \(same as implementation\)$/, '') as
    | 'OpenCode'
    | 'Claude-Kimi';

  const reviewerModels = reviewerHarness === harness ? models : await input.discoverModels(reviewerHarness);
  if (!reviewerModels.length) {
    input.io.stdout.write(
      `No models available for ${reviewerHarness}. Configure the provider and run \`afk\` again.\n`,
    );
    return { cancelled: true };
  }

  const reviewerModelChoices = prioritizeModelChoices(reviewerModels, input.preferences?.reviewerModelId);
  const selectedReviewerModelId = await promptSingleSelect(input.io, 'Select reviewer model', reviewerModelChoices, 0);
  if (!selectedReviewerModelId) return { cancelled: true };
  const reviewerModel = reviewerModels.find((item) => item.id === selectedReviewerModelId);
  if (!reviewerModel) return { cancelled: true };

  const reviewerPrompt = resolveReviewerPromptTemplate();

  const selectedTickets = await promptFeatureMultiSelect(input.io, input.tickets);
  if (!selectedTickets) return { cancelled: true };
  const concurrency = await promptConcurrency(input.io, input.preferences?.concurrency ?? 3);
  if (!concurrency) return { cancelled: true };
  const mergeBackToBase = await promptMergeBackToBase(input.io, input.preferences?.mergeBackToBase);
  if (mergeBackToBase === null) return { cancelled: true };

  return {
    cancelled: false,
    harness: harness as 'OpenCode',
    model,
    reviewerHarness: reviewerHarness as 'OpenCode',
    reviewerModel,
    reviewerPrompt,
    tickets: selectedTickets,
    concurrency,
    mergeBackToBase,
  };
}

interface PromptChoice {
  title: string;
  value: string;
}

interface PromptSuggestChoice {
  title?: string;
}

export function formatModelSelectionTitle(model: LaunchModel): string {
  const slash = model.id.indexOf('/');
  if (slash <= 0 || slash === model.id.length - 1) return model.label ?? model.id;
  const provider = model.id.slice(0, slash);
  const modelName = model.label ?? model.id.slice(slash + 1);
  return `${provider} - ${modelName}`;
}

export function prioritizeModelChoices(models: LaunchModel[], preferredModelId?: string): PromptChoice[] {
  const choices = models.map((model) => ({ title: formatModelSelectionTitle(model), value: model.id }));
  if (!preferredModelId) return choices;
  const preferredIndex = choices.findIndex((choice) => choice.value === preferredModelId);
  if (preferredIndex <= 0) return choices;
  const [preferred] = choices.splice(preferredIndex, 1);
  return [preferred, ...choices];
}

async function promptSingleSelect(
  _io: PromptIO,
  title: string,
  options: string[] | PromptChoice[],
  initial?: number,
): Promise<string | null> {
  const result = await prompts(
    {
      type: 'autocomplete',
      name: 'value',
      message: title,
      choices: options.map((option) => (typeof option === 'string' ? { title: option, value: option } : option)),
      initial,
      suggest: async (input: string, choices: PromptSuggestChoice[]) => {
        const query = input.trim().toLowerCase();
        if (!query) return choices;
        return choices.filter((choice) =>
          String(choice?.title ?? '')
            .toLowerCase()
            .includes(query),
        );
      },
    },
    {
      onCancel: () => true,
    },
  );
  return typeof result.value === 'string' ? result.value : null;
}

async function promptFeatureMultiSelect(io: PromptIO, tickets: TicketRecord[]): Promise<TicketRecord[] | null> {
  const features = [...new Set(tickets.map((ticket) => ticket.feature))].sort();
  while (true) {
    const result = await prompts(
      {
        type: 'autocompleteMultiselect',
        name: 'values',
        message: 'Select features to implement',
        choices: features.map((feature) => {
          const count = tickets.filter((ticket) => ticket.feature === feature).length;
          return { title: `${feature} (${count} eligible tickets)`, value: feature };
        }),
        instructions: true,
        min: 0,
        suggest: async (input: string, choices: PromptSuggestChoice[]) => {
          const query = input.trim().toLowerCase();
          if (!query) return choices;
          return choices.filter((choice) =>
            String(choice?.title ?? '')
              .toLowerCase()
              .includes(query),
          );
        },
      },
      {
        onCancel: () => true,
      },
    );

    if (!Array.isArray(result.values)) return null;
    if (!result.values.length) {
      io.stdout.write('Validation error: select at least one feature.\n');
      continue;
    }
    const selectedFeatures = new Set<string>(result.values as string[]);
    return tickets.filter((ticket) => selectedFeatures.has(ticket.feature));
  }
}

async function promptConcurrency(io: PromptIO, initial: number): Promise<number | null> {
  while (true) {
    const result = await prompts(
      {
        type: 'number',
        name: 'value',
        message: 'Global ticket concurrency',
        initial,
        min: 1,
        validate: (value: number) => (Number.isInteger(value) && value > 0 ? true : 'Enter a positive integer'),
      },
      { onCancel: () => true },
    );
    if (typeof result.value !== 'number') return null;
    if (Number.isInteger(result.value) && result.value > 0) return result.value;
    io.stdout.write('Validation error: enter a positive integer.\n');
  }
}

async function promptMergeBackToBase(_io: PromptIO, initial?: boolean): Promise<boolean | null> {
  const choices = [
    { title: 'Merge back to base branch on completion', value: 'true' },
    { title: 'Leave feature branches for manual inspection', value: 'false' },
  ];
  const result = await prompts(
    {
      type: 'autocomplete',
      name: 'value',
      message: 'After tickets complete, how should feature branches be handled?',
      choices,
      initial: initial === true ? 0 : initial === false ? 1 : undefined,
      suggest: async (input: string, choices: PromptSuggestChoice[]) => {
        const query = input.trim().toLowerCase();
        if (!query) return choices;
        return choices.filter((choice) =>
          String(choice?.title ?? '')
            .toLowerCase()
            .includes(query),
        );
      },
    },
    { onCancel: () => true },
  );
  if (typeof result.value !== 'string') return null;
  return result.value === 'true';
}
