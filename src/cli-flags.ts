/**
 * Reusable CLI argument parser for the `afk` command surface.
 *
 * Supports command detection from both compiled (`afk <cmd>`) and script
 * (`bun src/bin.ts <cmd>`) invocations, plus the flags needed for headless
 * launch and LLM-facing inspection commands.
 */

export interface CliFlags {
  json: boolean;
  dryRun: boolean;
  verbose: boolean;
  manifest?: string;
  harness?: string;
  model?: string;
  reviewerHarness?: string;
  reviewerModel?: string;
  features?: string[];
  concurrency?: number;
  completion?: string;
  sandbox?: string;
  offset?: number;
}

export interface ParsedCliArgs {
  command: string | undefined;
  flags: CliFlags;
  positionals: string[];
}

const KNOWN_COMMANDS = new Set([
  'summary',
  'afk-summary',
  'cleanup',
  'afk-cleanup',
  'sync',
  'linear-plan',
  'tui',
  'stop',
  'status',
  '__daemon',
  'run',
  'pause',
  'resume',
  'plan',
  'events',
]);

const VALID_COMMANDS = new Set([
  'afk-summary',
  'afk-cleanup',
  'sync',
  'linear-plan',
  'tui',
  'stop',
  'status',
  '__daemon',
  'run',
  'pause',
  'resume',
  'plan',
  'events',
]);

function isKnownCommand(arg: string | undefined): arg is string {
  return !!arg && KNOWN_COMMANDS.has(arg);
}

function normalizeCommand(command: string): string {
  if (command === 'summary' || command === 'afk-summary') return 'afk-summary';
  if (command === 'cleanup' || command === 'afk-cleanup') return 'afk-cleanup';
  return command;
}

function looksLikeScriptPath(arg: string | undefined): boolean {
  if (!arg) return false;
  return arg.includes('/') || arg.endsWith('.ts') || arg.endsWith('.js');
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return undefined;
  return num;
}

function parseByteOffset(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) return undefined;
  return num;
}

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isCommandLike(arg: string | undefined): boolean {
  return !!arg && !arg.startsWith('-');
}

/**
 * Parse the raw `process.argv`-style array into a normalized command and flags.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command: string | undefined;
  let flagStartIndex: number;

  if (isKnownCommand(argv[1])) {
    command = normalizeCommand(argv[1]);
    flagStartIndex = 2;
  } else if (isKnownCommand(argv[2])) {
    command = normalizeCommand(argv[2]);
    flagStartIndex = 3;
  } else if (isCommandLike(argv[1]) && !looksLikeScriptPath(argv[1])) {
    // Compiled binary with an unknown command.
    command = argv[1];
    flagStartIndex = 2;
  } else if (isCommandLike(argv[2])) {
    // Script invocation with an unknown command.
    command = argv[2];
    flagStartIndex = 3;
  } else {
    command = undefined;
    // In `bun src/bin.ts ...` argv[1] is the script; in a compiled binary
    // `afk ...` argv[1] is the first real argument.
    flagStartIndex = looksLikeScriptPath(argv[1]) ? 2 : 1;
  }

  const argsToParse = argv.slice(flagStartIndex);

  const flags: CliFlags = { json: false, dryRun: false, verbose: false };
  const positionals: string[] = [];

  for (let i = 0; i < argsToParse.length; i++) {
    const arg = argsToParse[i];
    if (arg === undefined) continue;

    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    const equalIndex = arg.indexOf('=');
    const key = equalIndex >= 0 ? arg.slice(0, equalIndex) : arg;
    const value = equalIndex >= 0 ? arg.slice(equalIndex + 1) : undefined;

    switch (key) {
      case '--json':
        flags.json = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        flags.verbose = true;
        break;
      case '--manifest':
        flags.manifest = value ?? argsToParse[++i];
        break;
      case '--harness':
        flags.harness = value ?? argsToParse[++i];
        break;
      case '--model':
        flags.model = value ?? argsToParse[++i];
        break;
      case '--reviewer-harness':
        flags.reviewerHarness = value ?? argsToParse[++i];
        break;
      case '--reviewer-model':
        flags.reviewerModel = value ?? argsToParse[++i];
        break;
      case '--features':
        flags.features = splitCommaList(value ?? argsToParse[++i] ?? '');
        break;
      case '--concurrency':
        flags.concurrency = parsePositiveInteger(value ?? argsToParse[++i]);
        break;
      case '--completion':
        flags.completion = value ?? argsToParse[++i];
        break;
      case '--sandbox':
        flags.sandbox = value ?? argsToParse[++i];
        break;
      case '--offset':
        flags.offset = parseByteOffset(value ?? argsToParse[++i]);
        break;
      default:
        // Unknown flags are ignored. If the flag uses `--key=value` the value
        // is discarded; if it uses `--key value` the value is left as a
        // positional so existing commands can still see it.
        break;
    }
  }

  return { command, flags, positionals };
}

/**
 * Returns true when the normalized command is recognized by the CLI.
 */
export function isValidCommand(command: string | undefined): boolean {
  return !!command && VALID_COMMANDS.has(command);
}
