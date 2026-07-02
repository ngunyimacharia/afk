/**
 * Reusable JSON response envelopes for LLM-facing `afk` commands.
 *
 * When `--json` is passed the CLI serializes results through these envelopes
 * instead of human-readable text. Text-mode callers continue to receive the
 * original `{ code, message }` shape.
 */

export interface CliResult {
  code: number;
  message: string;
}

export interface JsonSuccessEnvelope {
  ok: true;
  command: string;
  message?: string;
  data?: object;
}

export interface JsonErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: object;
  };
}

export function formatJsonSuccess(command: string | undefined, message: string): CliResult {
  const envelope: JsonSuccessEnvelope = { ok: true, command: command ?? 'unknown' };
  if (message) {
    envelope.message = message;
  }
  return { code: 0, message: JSON.stringify(envelope) };
}

export function formatJsonSuccessWithData(command: string | undefined, data: object): CliResult {
  return {
    code: 0,
    message: JSON.stringify({ ok: true, command: command ?? 'unknown', data }),
  };
}

export function formatJsonError(
  command: string | undefined,
  code: string,
  message: string,
  details?: object,
): CliResult {
  const envelope: JsonErrorEnvelope = {
    ok: false,
    command: command ?? 'unknown',
    error: { code, message },
  };
  if (details) {
    envelope.error.details = details;
  }
  return { code: 1, message: JSON.stringify(envelope) };
}

export function formatNotImplemented(command: string | undefined, isJson: boolean): CliResult {
  const message = `The '${command ?? 'unknown'}' command is not yet implemented.`;
  if (!isJson) return { code: 1, message };
  return formatJsonError(command, 'not-implemented', message);
}

export function formatUnknownCommand(command: string | undefined, isJson: boolean): CliResult {
  const message = `Unknown command: ${command ?? ''}`;
  if (!isJson) return { code: 1, message };
  return formatJsonError(command, 'unknown-command', message);
}
