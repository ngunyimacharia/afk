export type AssetCategory = {
  name: string;
  sourceRoot: string;
  destinationRoot: string;
  destinationBase?: string;
  extensions?: string[];
  validateSource?: (path: string) => Promise<void> | void;
  mapDestination?: (sourceFileName: string, destinationRoot: string) => string;
};

export type SyncAdapter = {
  id: string;
  assetCategories: () => AssetCategory[];
};

export type SyncActionStatus = 'created' | 'updated' | 'unchanged' | 'skipped';

export type SyncAction = {
  category: string;
  sourcePath: string;
  destinationPath: string;
  status: SyncActionStatus;
};

export type SyncReport = {
  adapterId: string;
  actions: SyncAction[];
  counts: Record<SyncActionStatus, number>;
};

export type SyncRenderLine = {
  label: string;
  value: string;
};
