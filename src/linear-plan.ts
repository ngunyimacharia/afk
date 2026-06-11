import { existsSync, readFileSync } from 'node:fs';
import { GraphQLLinearProvider, type LinearIssueResult, type LinearProvider } from './linear-provider.js';
import { loadAfkProjectConfig } from './project-config.js';

export interface LinearPlanManifest {
  parents: LinearPlanParentManifest[];
}

export interface LinearPlanParentManifest {
  ref: string;
  title: string;
  description: string;
  updateIntent?: string;
  subIssues: LinearPlanSubIssueManifest[];
}

export interface LinearPlanSubIssueManifest {
  ref: string;
  title: string;
  description: string;
  dependsOn?: string[];
  updateIntent?: string;
}

export interface LinearPlanResult {
  parents: Array<{
    ref: string;
    issue: LinearIssueResult;
    subIssues: Array<{ ref: string; issue: LinearIssueResult; dependsOn: string[] }>;
  }>;
  dependencyOrder: string[];
}

export function parseLinearPlanManifest(value: unknown): { manifest?: LinearPlanManifest; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { errors: ['manifest must be a JSON object.'] };
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.parents) || record.parents.length === 0) {
    return { errors: ['parents must be a non-empty array.'] };
  }

  const parents: LinearPlanParentManifest[] = [];
  const parentRefs = new Set<string>();
  for (const [parentIndex, rawParent] of record.parents.entries()) {
    if (!rawParent || typeof rawParent !== 'object' || Array.isArray(rawParent)) {
      errors.push(`parents[${parentIndex}] must be an object.`);
      continue;
    }
    const parent = rawParent as Record<string, unknown>;
    const ref = requiredString(parent.ref, `parents[${parentIndex}].ref`, errors);
    const title = requiredString(parent.title, `parents[${parentIndex}].title`, errors);
    const description = requiredString(parent.description, `parents[${parentIndex}].description`, errors);
    const updateIntent = optionalString(parent.updateIntent, `parents[${parentIndex}].updateIntent`, errors);
    if (ref && parentRefs.has(ref)) errors.push(`parents[${parentIndex}].ref duplicates another parent ref.`);
    if (ref) parentRefs.add(ref);
    if (!Array.isArray(parent.subIssues) || parent.subIssues.length === 0) {
      errors.push(`parents[${parentIndex}].subIssues must be a non-empty array.`);
      continue;
    }

    const subIssues: LinearPlanSubIssueManifest[] = [];
    const subIssueRefs = new Set<string>();
    for (const [subIndex, rawSubIssue] of parent.subIssues.entries()) {
      if (!rawSubIssue || typeof rawSubIssue !== 'object' || Array.isArray(rawSubIssue)) {
        errors.push(`parents[${parentIndex}].subIssues[${subIndex}] must be an object.`);
        continue;
      }
      const subIssue = rawSubIssue as Record<string, unknown>;
      const subRef = requiredString(subIssue.ref, `parents[${parentIndex}].subIssues[${subIndex}].ref`, errors);
      const subTitle = requiredString(subIssue.title, `parents[${parentIndex}].subIssues[${subIndex}].title`, errors);
      const subDescription = requiredString(
        subIssue.description,
        `parents[${parentIndex}].subIssues[${subIndex}].description`,
        errors,
      );
      const subUpdateIntent = optionalString(
        subIssue.updateIntent,
        `parents[${parentIndex}].subIssues[${subIndex}].updateIntent`,
        errors,
      );
      const dependsOn = optionalStringArray(
        subIssue.dependsOn,
        `parents[${parentIndex}].subIssues[${subIndex}].dependsOn`,
        errors,
      );
      if (subRef && subIssueRefs.has(subRef))
        errors.push(`parents[${parentIndex}].subIssues[${subIndex}].ref duplicates another sub-issue ref.`);
      if (subRef) subIssueRefs.add(subRef);
      if (subRef && subTitle && subDescription) {
        subIssues.push({
          ref: subRef,
          title: subTitle,
          description: subDescription,
          dependsOn,
          ...(subUpdateIntent ? { updateIntent: subUpdateIntent } : {}),
        });
      }
    }
    for (const subIssue of subIssues) {
      for (const dependency of subIssue.dependsOn ?? []) {
        if (!subIssueRefs.has(dependency))
          errors.push(`${subIssue.ref} depends on unknown sub-issue ref ${dependency}.`);
        if (dependency === subIssue.ref) errors.push(`${subIssue.ref} cannot depend on itself.`);
      }
    }
    const cycle = findDependencyCycle(subIssues);
    if (cycle) errors.push(`dependency cycle detected: ${cycle.join(' -> ')}.`);
    if (ref && title && description)
      parents.push({ ref, title, description, subIssues, ...(updateIntent ? { updateIntent } : {}) });
  }

  return errors.length ? { errors } : { manifest: { parents }, errors: [] };
}

export function loadLinearPlanManifest(filePath: string): { manifest?: LinearPlanManifest; errors: string[] } {
  if (!existsSync(filePath)) return { errors: [`manifest file not found: ${filePath}`] };
  try {
    return parseLinearPlanManifest(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    return { errors: [`invalid manifest JSON: ${reason}`] };
  }
}

export function createLinearProviderFromConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { provider?: LinearProvider; teamId?: string; errors: string[] } {
  const config = loadAfkProjectConfig(repoRoot);
  if (!config.config) return { errors: config.errors };
  if (!config.config.linear) return { errors: ['Linear config missing: add linear.teamId to afk.json.'] };
  const apiKeyEnv = config.config.linear.apiKeyEnv ?? 'LINEAR_API_KEY';
  const apiKey = env[apiKeyEnv];
  if (!apiKey) return { errors: [`Linear API key missing: set ${apiKeyEnv}.`] };
  return { provider: new GraphQLLinearProvider({ apiKey }), teamId: config.config.linear.teamId, errors: [] };
}

export async function createLinearPlan(input: {
  manifest: LinearPlanManifest;
  teamId: string;
  provider: LinearProvider;
}): Promise<LinearPlanResult> {
  const parents: LinearPlanResult['parents'] = [];
  const dependencyOrder: string[] = [];
  for (const parent of input.manifest.parents) {
    const parentIssue = await input.provider.createIssue({
      teamId: input.teamId,
      title: parent.title,
      description: appendUpdateIntent(parent.description, parent.updateIntent),
    });
    const issueByRef = new Map<string, LinearIssueResult>();
    const subIssues: Array<{ ref: string; issue: LinearIssueResult; dependsOn: string[] }> = [];
    for (const subIssue of orderSubIssues(parent.subIssues)) {
      const created = await input.provider.createIssue({
        teamId: input.teamId,
        title: subIssue.title,
        description: appendUpdateIntent(subIssue.description, subIssue.updateIntent),
        parentId: parentIssue.id,
      });
      issueByRef.set(subIssue.ref, created);
      subIssues.push({ ref: subIssue.ref, issue: created, dependsOn: subIssue.dependsOn ?? [] });
      dependencyOrder.push(subIssue.ref);
    }
    for (const subIssue of parent.subIssues) {
      const issue = issueByRef.get(subIssue.ref);
      if (!issue) continue;
      for (const dependencyRef of subIssue.dependsOn ?? []) {
        const dependency = issueByRef.get(dependencyRef);
        if (dependency)
          await input.provider.createIssueDependency({ issueId: issue.id, dependsOnIssueId: dependency.id });
      }
    }
    parents.push({ ref: parent.ref, issue: parentIssue, subIssues });
  }
  return { parents, dependencyOrder };
}

function requiredString(value: unknown, field: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} must be a non-empty string.`);
    return undefined;
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} must be a non-empty string when present.`);
    return undefined;
  }
  return value.trim();
}

function optionalStringArray(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push(`${field} must be an array of non-empty strings when present.`);
    return undefined;
  }
  return value.map((item) => item.trim());
}

function appendUpdateIntent(description: string, updateIntent: string | undefined): string {
  return updateIntent ? `${description}\n\nUpdate intent: ${updateIntent}` : description;
}

function orderSubIssues(subIssues: LinearPlanSubIssueManifest[]): LinearPlanSubIssueManifest[] {
  const byRef = new Map(subIssues.map((issue) => [issue.ref, issue]));
  const ordered: LinearPlanSubIssueManifest[] = [];
  const visited = new Set<string>();
  const visit = (issue: LinearPlanSubIssueManifest) => {
    if (visited.has(issue.ref)) return;
    visited.add(issue.ref);
    for (const dependency of issue.dependsOn ?? []) {
      const dependencyIssue = byRef.get(dependency);
      if (dependencyIssue) visit(dependencyIssue);
    }
    ordered.push(issue);
  };
  for (const issue of subIssues) visit(issue);
  return ordered;
}

function findDependencyCycle(subIssues: LinearPlanSubIssueManifest[]): string[] | undefined {
  const byRef = new Map(subIssues.map((issue) => [issue.ref, issue]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (issue: LinearPlanSubIssueManifest): string[] | undefined => {
    if (visited.has(issue.ref)) return undefined;
    if (visiting.has(issue.ref)) return [...stack.slice(stack.indexOf(issue.ref)), issue.ref];
    visiting.add(issue.ref);
    stack.push(issue.ref);
    for (const dependencyRef of issue.dependsOn ?? []) {
      const dependency = byRef.get(dependencyRef);
      if (dependency) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    visiting.delete(issue.ref);
    visited.add(issue.ref);
    stack.pop();
    return undefined;
  };
  for (const issue of subIssues) {
    const cycle = visit(issue);
    if (cycle) return cycle;
  }
  return undefined;
}
