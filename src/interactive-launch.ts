import prompts from 'prompts';
import { resolveReviewerPromptTemplate } from './reviewer-prompt-catalog.js';
import type { LaunchModel, LaunchPreferences, ReviewerPromptTemplate, TicketRecord } from './types.js';

export interface PromptIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface LaunchWizardResult {
  cancelled: boolean;
  harness?: 'OpenCode';
  model?: LaunchModel;
  reviewerModel?: LaunchModel;
  reviewerPrompt?: ReviewerPromptTemplate;
  tickets?: TicketRecord[];
  concurrency?: number;
}

export function isInteractiveLaunchAllowed(io: PromptIO, env: NodeJS.ProcessEnv): { ok: boolean; reason?: string } {
  if (env.CI) return { ok: false, reason: 'AFK launch requires an interactive TTY and does not run in CI.' };
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    return { ok: false, reason: 'AFK launch requires an interactive terminal (TTY). Run `afk` directly in a terminal.' };
  }
  return { ok: true };
}

export async function runInteractiveLaunchWizard(input: {
  io: PromptIO;
  repoRoot: string;
  models: LaunchModel[];
  tickets: TicketRecord[];
  preferences?: LaunchPreferences;
}): Promise<LaunchWizardResult> {
  const harnessChoices = ['OpenCode'];
  const harnessInitial = input.preferences?.harness === 'OpenCode' ? 0 : undefined;
  const harness = await promptSingleSelect(input.io, 'Select harness', harnessChoices, harnessInitial);
  if (!harness) return { cancelled: true };

  const modelChoices = prioritizeModelChoices(input.models, input.preferences?.modelId);
  const selectedModelId = await promptSingleSelect(input.io, 'Select implementation model', modelChoices, 0);
  if (!selectedModelId) return { cancelled: true };
  const model = input.models.find((item) => item.id === selectedModelId);
  if (!model) return { cancelled: true };

  const reviewerModelChoices = prioritizeModelChoices(input.models, input.preferences?.reviewerModelId);
  const selectedReviewerModelId = await promptSingleSelect(input.io, 'Select reviewer model', reviewerModelChoices, 0);
  if (!selectedReviewerModelId) return { cancelled: true };
  const reviewerModel = input.models.find((item) => item.id === selectedReviewerModelId);
  if (!reviewerModel) return { cancelled: true };

  const reviewerPrompt = resolveReviewerPromptTemplate();

  const selectedTickets = await promptFeatureMultiSelect(input.io, input.tickets);
  if (!selectedTickets) return { cancelled: true };
  const concurrency = await promptConcurrency(input.io, input.preferences?.concurrency ?? 3);
  if (!concurrency) return { cancelled: true };

  return { cancelled: false, harness: 'OpenCode', model, reviewerModel, reviewerPrompt, tickets: selectedTickets, concurrency };
}

export async function confirmDisabledTestsForMissingEnv(io: PromptIO, feature: string): Promise<boolean> {
  const result = await prompts(
    {
      type: 'confirm',
      name: 'value',
      message: `Tests were detected for ${feature}, but source .env.testing is missing. Treat tests as disabled for this AFK run?`,
      initial: false,
    },
    { onCancel: () => true },
  );
  return result.value === true;
}

interface PromptChoice {
  title: string;
  value: string;
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

async function promptSingleSelect(io: PromptIO, title: string, options: string[] | PromptChoice[], initial?: number): Promise<string | null> {
  const result = await prompts(
    {
      type: 'autocomplete',
      name: 'value',
      message: title,
      choices: options.map((option) => (typeof option === 'string' ? { title: option, value: option } : option)),
      initial,
      suggest: async (input: string, choices: any[]) => {
        const query = input.trim().toLowerCase();
        if (!query) return choices;
        return choices.filter((choice) => String(choice?.title ?? '').toLowerCase().includes(query));
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
        suggest: async (input: string, choices: any[]) => {
          const query = input.trim().toLowerCase();
          if (!query) return choices;
          return choices.filter((choice) => String(choice?.title ?? '').toLowerCase().includes(query));
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
