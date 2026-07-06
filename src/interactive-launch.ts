import prompts from 'prompts';
import { displayNameForHarness, isSelectableHarnessId, type SelectableHarnessId } from './harness-registry.js';
import { resolveReviewerPromptTemplate } from './reviewer-prompt-catalog.js';
import type {
  FeatureCompletionAction,
  LaunchModel,
  LaunchPreferences,
  ReviewerPromptTemplate,
  SandboxMode,
  TicketRecord,
} from './types.js';

export interface PromptIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface LaunchWizardResult {
  cancelled: boolean;
  harness?: SelectableHarnessId;
  model?: LaunchModel;
  reviewerHarness?: SelectableHarnessId;
  reviewerModel?: LaunchModel;
  reviewerPrompt?: ReviewerPromptTemplate;
  tickets?: TicketRecord[];
  concurrency?: number;
  featureCompletionAction?: FeatureCompletionAction;
  mergeBackToBase?: boolean;
  sandboxMode?: SandboxMode;
}

export const dockerSandboxChoices: Array<{ title: string; value: SandboxMode }> = [
  { title: 'Docker isolation (recommended)', value: 'docker' },
  { title: 'No sandbox (explicitly accept host execution risk)', value: 'no-sandbox' },
];

export const noDockerSandboxChoices: Array<{ title: string; value: SandboxMode | 'abort' }> = [
  { title: 'Continue without sandbox (host execution)', value: 'no-sandbox' },
  { title: 'Abort launch', value: 'abort' },
];

export const featureCompletionActionChoices: Array<{ title: string; value: FeatureCompletionAction }> = [
  { title: 'Merge back to base branch on completion', value: 'merge-to-base' },
  { title: 'Create a GitHub PR for completed feature branches', value: 'create-pr' },
];

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
  availableHarnesses: SelectableHarnessId[];
  discoverModels: (harness: SelectableHarnessId) => Promise<LaunchModel[]>;
  tickets: TicketRecord[];
  preferences?: LaunchPreferences;
  dockerAvailable: boolean;
}): Promise<LaunchWizardResult> {
  const harnessChoices = input.availableHarnesses;
  if (harnessChoices.length === 0) {
    input.io.stdout.write('No harnesses available. Install and configure OpenCode, Claude, Codex, or PI.\n');
    return { cancelled: true };
  }

  const harnessInitial = input.preferences?.harness ? harnessChoices.indexOf(input.preferences.harness) : undefined;
  const selectedHarness = await promptSingleSelect(
    input.io,
    'Select implementation harness',
    harnessChoices,
    harnessInitial,
  );
  if (!selectedHarness || !isSelectableHarnessId(selectedHarness)) return { cancelled: true };
  const harness = selectedHarness;

  const sandboxMode = await promptSandboxMode(input.io, input.dockerAvailable, input.preferences);
  if (!sandboxMode) return { cancelled: true };

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
    choice === harness ? `${displayNameForHarness(choice)} (same as implementation)` : displayNameForHarness(choice),
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
  const reviewerHarnessIndex = reviewerHarnessChoices.indexOf(selectedReviewerHarnessDisplay);
  const reviewerHarness = harnessChoices[reviewerHarnessIndex];
  if (!reviewerHarness || !isSelectableHarnessId(reviewerHarness)) return { cancelled: true };

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
  const featureCompletionAction = await promptFeatureCompletionAction(input.io, input.preferences);
  if (!featureCompletionAction) return { cancelled: true };
  const mergeBackToBase = featureCompletionAction === 'merge-to-base';

  return {
    cancelled: false,
    harness,
    model,
    reviewerHarness,
    reviewerModel,
    reviewerPrompt,
    tickets: selectedTickets,
    concurrency,
    featureCompletionAction,
    mergeBackToBase,
    sandboxMode,
  };
}

interface PromptChoice {
  title: string;
  value: string;
}

interface PromptSuggestChoice {
  title?: string;
  value?: string;
}

export function formatModelSelectionTitle(model: LaunchModel): string {
  const slash = model.id.indexOf('/');
  if (slash <= 0 || slash === model.id.length - 1) return model.label ?? model.id;
  const provider = model.id.slice(0, slash);
  const modelName = model.label ?? model.id.slice(slash + 1);
  return `${provider} - ${modelName}`;
}

export function formatFeatureSelectionTitle(feature: string, featureTitle: string | undefined, count: number): string {
  const title = featureTitle && featureTitle !== feature ? truncateWithEllipsis(featureTitle, 50) : undefined;
  if (title) return `${feature} — ${title} (${count} eligible tickets)`;
  return `${feature} (${count} eligible tickets)`;
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
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
  const featureTitles = new Map(
    features.map((feature) => {
      const title = tickets.find((ticket) => ticket.feature === feature)?.featureTitle;
      return [feature, title];
    }),
  );
  while (true) {
    const result = await prompts(
      {
        type: 'autocompleteMultiselect',
        name: 'values',
        message: 'Select features to implement',
        choices: features.map((feature) => {
          const count = tickets.filter((ticket) => ticket.feature === feature).length;
          return {
            title: formatFeatureSelectionTitle(feature, featureTitles.get(feature), count),
            value: feature,
          };
        }),
        instructions: true,
        min: 0,
        suggest: async (input: string, choices: PromptSuggestChoice[]) => {
          const query = input.trim().toLowerCase();
          if (!query) return choices;
          return choices.filter((choice) =>
            String(choice?.value ?? '')
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

function preferredFeatureCompletionAction(preferences?: LaunchPreferences): FeatureCompletionAction {
  if (preferences?.featureCompletionAction) return preferences.featureCompletionAction;
  return 'merge-to-base';
}

async function promptFeatureCompletionAction(
  _io: PromptIO,
  preferences?: LaunchPreferences,
): Promise<FeatureCompletionAction | null> {
  const initialValue = preferredFeatureCompletionAction(preferences);
  const initial = featureCompletionActionChoices.findIndex((choice) => choice.value === initialValue);
  const result = await prompts(
    {
      type: 'autocomplete',
      name: 'value',
      message: 'After tickets complete, how should feature branches be handled?',
      choices: featureCompletionActionChoices,
      initial: initial >= 0 ? initial : 0,
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
  if (result.value === 'merge-to-base' || result.value === 'create-pr') return result.value;
  return null;
}

async function promptSandboxMode(
  _io: PromptIO,
  dockerAvailable: boolean,
  preferences?: LaunchPreferences,
): Promise<SandboxMode | null> {
  const choices = dockerAvailable ? dockerSandboxChoices : noDockerSandboxChoices;
  const preferred = dockerAvailable ? preferences?.sandboxMode : undefined;
  const initial = preferred ? choices.findIndex((choice) => choice.value === preferred) : 0;
  const result = await prompts(
    {
      type: 'autocomplete',
      name: 'value',
      message: dockerAvailable
        ? 'Select sandbox mode for this run'
        : 'Docker is unavailable. Continue without sandboxing?',
      choices,
      initial: initial >= 0 ? initial : 0,
      suggest: async (input: string, promptChoices: PromptSuggestChoice[]) => {
        const query = input.trim().toLowerCase();
        if (!query) return promptChoices;
        return promptChoices.filter((choice) =>
          String(choice?.title ?? '')
            .toLowerCase()
            .includes(query),
        );
      },
    },
    { onCancel: () => true },
  );
  if (result.value === 'docker' || result.value === 'no-sandbox') return result.value;
  return null;
}
