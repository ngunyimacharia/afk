import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { TicketRecord } from './types.js';

export type LaunchBlockKind = 'path-validation';

export interface LaunchBlockEvidence {
  kind: LaunchBlockKind;
  message: string;
  ticketLabel: string;
  feature: string;
  issueName: string;
  path: string;
}

export class PathValidationError extends Error {
  readonly kind: LaunchBlockKind;

  constructor(message: string, kind: LaunchBlockKind = 'path-validation') {
    super(message);
    this.name = 'PathValidationError';
    this.kind = kind;
  }
}

export function validateSelectedTicketPath(repoRoot: string, ticket: TicketRecord): LaunchBlockEvidence | null {
  const scratchRoot = path.resolve(repoRoot, '.scratch');
  if (ticket.source === 'linear') return validateLinearMirrorPath(repoRoot, ticket);

  const expectedIssuesRoot = path.resolve(scratchRoot, ticket.feature, 'issues');
  const selectedPath = path.resolve(ticket.path);
  const expectedPath = path.resolve(expectedIssuesRoot, `${ticket.issueName}.md`);

  if (!isWithinRoot(selectedPath, scratchRoot)) return null;

  if (!isWithinRoot(selectedPath, expectedIssuesRoot)) {
    return launchBlock(
      ticket,
      ticket.path,
      `Invalid selected issue path for ${ticket.label}: must be under ${expectedIssuesRoot}`,
    );
  }
  if (selectedPath !== expectedPath) {
    return launchBlock(
      ticket,
      ticket.path,
      `Invalid selected issue layout for ${ticket.label}: expected ${expectedPath}`,
    );
  }
  if (!existsSync(selectedPath) || !safeIsFile(selectedPath)) {
    return launchBlock(ticket, ticket.path, `Selected issue path missing for ${ticket.label}: ${selectedPath}`);
  }
  return null;
}

function validateLinearMirrorPath(repoRoot: string, ticket: TicketRecord): LaunchBlockEvidence | null {
  const mirrorRoot = path.resolve(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors');
  const selectedPath = path.resolve(ticket.path);
  if (!isWithinRoot(selectedPath, mirrorRoot)) {
    return launchBlock(
      ticket,
      ticket.path,
      `Invalid Linear mirror path for ${ticket.label}: must be under ${mirrorRoot}`,
    );
  }
  if (!existsSync(selectedPath) || !safeIsFile(selectedPath)) {
    return launchBlock(ticket, ticket.path, `Linear mirror path missing for ${ticket.label}: ${selectedPath}`);
  }
  return null;
}

export function assertPathWithinRoot(targetPath: string, rootPath: string, label: string): void {
  if (!isWithinRoot(path.resolve(targetPath), path.resolve(rootPath))) {
    throw new PathValidationError(`Invalid ${label} path: ${targetPath} escapes ${rootPath}`);
  }
}

function launchBlock(ticket: TicketRecord, selectedPath: string, message: string): LaunchBlockEvidence {
  return {
    kind: 'path-validation',
    message,
    ticketLabel: ticket.label,
    feature: ticket.feature,
    issueName: ticket.issueName,
    path: selectedPath,
  };
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function safeIsFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}
