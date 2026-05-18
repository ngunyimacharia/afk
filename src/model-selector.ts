import type { LaunchModel } from './types.js';

export type ModelChooser = (models: LaunchModel[]) => Promise<LaunchModel | null>;

export class ModelSelector {
  constructor(private readonly discoverModels: () => Promise<LaunchModel[]>, private readonly chooser: ModelChooser) {}

  async selectModel(): Promise<LaunchModel> {
    const models = await this.discoverModels();
    if (!models.length) throw new Error('No OpenCode models available');
    const selected = await this.chooser(models);
    if (!selected) throw new Error('No model selected');
    return selected;
  }
}
