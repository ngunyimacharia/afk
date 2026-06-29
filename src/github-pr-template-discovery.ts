import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type GithubPrTemplateDiscoveryResult =
  | {
      kind: 'selected';
      path: string;
      content: string;
      candidatePaths: string[];
    }
  | {
      kind: 'multiple';
      candidatePaths: string[];
    }
  | {
      kind: 'none';
      candidatePaths: [];
    };

const TEMPLATE_FILE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'PULL_REQUEST_TEMPLATE.md',
] as const;

const DIRECTORY_TEMPLATE_ROOT = '.github/PULL_REQUEST_TEMPLATE';

function readTemplate(repoRoot: string, repoRelativePath: string): string | undefined {
  try {
    return readFileSync(path.join(repoRoot, repoRelativePath), 'utf8');
  } catch {
    return undefined;
  }
}

function discoverDirectoryTemplatePaths(repoRoot: string): string[] {
  try {
    return readdirSync(path.join(repoRoot, DIRECTORY_TEMPLATE_ROOT), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => `${DIRECTORY_TEMPLATE_ROOT}/${entry.name}`)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export function discoverGithubPrTemplates(repoRoot: string): GithubPrTemplateDiscoveryResult {
  for (const repoRelativePath of TEMPLATE_FILE_PATHS.slice(0, 2)) {
    const content = readTemplate(repoRoot, repoRelativePath);
    if (content !== undefined) {
      return { kind: 'selected', path: repoRelativePath, content, candidatePaths: [repoRelativePath] };
    }
  }

  const directoryCandidatePaths = discoverDirectoryTemplatePaths(repoRoot);
  if (directoryCandidatePaths.length > 1) {
    return { kind: 'multiple', candidatePaths: directoryCandidatePaths };
  }
  if (directoryCandidatePaths.length === 1) {
    const [repoRelativePath] = directoryCandidatePaths;
    const content = readTemplate(repoRoot, repoRelativePath);
    if (content !== undefined) {
      return { kind: 'selected', path: repoRelativePath, content, candidatePaths: [repoRelativePath] };
    }
  }

  for (const repoRelativePath of TEMPLATE_FILE_PATHS.slice(2)) {
    const content = readTemplate(repoRoot, repoRelativePath);
    if (content !== undefined) {
      return { kind: 'selected', path: repoRelativePath, content, candidatePaths: [repoRelativePath] };
    }
  }

  return { kind: 'none', candidatePaths: [] };
}
