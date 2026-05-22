# Integrate Claude Code as an AFK Execution Provider

## Executive Summary

Add Claude Code (Anthropic) as a third harness option alongside OpenCode and Kimi. The integration uses the official `@anthropic-ai/claude-agent-sdk` (v0.3.148) to provide programmatic session execution, progress streaming, and permission handling — matching the existing architecture.

## Architecture Analysis

AFK uses a clean two-layer provider architecture:

1. **Session Executor** (`OpenCodeSessionExecutor` interface in `src/opencode.ts`)
   - `SDKOpenCodeSessionExecutor` — wraps `@opencode-ai/sdk`
   - `KimiSessionExecutor` — wraps `@moonshot-ai/kimi-agent-sdk`
   - Both implement: `run(input) → Promise<{sessionId, output, terminalError, finalMessageText}>`

2. **Execution Provider** (`AgentExecutionProvider` interface in `src/agent-execution-provider.ts`)
   - `BaseSDKAgentExecutionProvider` — generic wrapper around any `OpenCodeSessionExecutor`
   - `OpenCodeAgentExecutionProvider` — configures with `providerName: 'opencode'`, `agentName: 'build'`
   - `KimiAgentExecutionProvider` — configures with `providerName: 'kimi'`

Claude Code fits this architecture by implementing a new `ClaudeCodeSessionExecutor` and `ClaudeCodeAgentExecutionProvider`.

## Key Design Decisions

### 1. SDK vs CLI Subprocess
**Decision: Use the official SDK (`@anthropic-ai/claude-agent-sdk`)**

Rationale:
- Provides `query()` / `startup()` APIs that return async generators of typed messages
- Supports explicit `sessionId` (UUID) generation and `resume` for session resumption
- Has `canUseTool` callback for permission decisions, mapping cleanly to AFK's `decidePermission`
- Supports `interrupt()` for stale session recovery
- Has `supportedModels()` for model discovery via a `WarmQuery` handle

Trade-off: The SDK is brand new (published May 2025, v0.3.148) and carries peer dependencies on `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod`.

### 2. Model ID Mapping
Claude Code models are specified as simple strings (e.g., `claude-sonnet-4-6`, `opus`, `haiku`). The `LaunchModel.id` field in AFK uses `provider/model` format (e.g., `anthropic/claude-sonnet-4-6`).

**Approach:** Store full IDs like `anthropic/claude-sonnet-4-6` in `LaunchModel`, strip the `anthropic/` prefix when passing to the SDK.

### 3. Agent Names
OpenCode uses named agents (`build` for execution, `review` for reviewer). Kimi does not use agents. Claude Code supports custom agents via the `agents` option but does not require them.

**Approach:** Do not set `agentName` for Claude Code initially (like Kimi). Future enhancement can define Claude Code custom agents for build/review roles.

### 4. Permission Model
The SDK's `canUseTool` callback receives `(toolName, input, options)` and returns a `PermissionResult` (`{decision: 'allow' | 'deny', updatedPermissions?}`). This maps to AFK's `OpenCodePermissionRequest` / `OpenCodePermissionDecision` model with some translation.

**Approach:** Map `canUseTool` to the existing `decidePermission` callback. Auto-approve all tools (matching current AFK behavior where `decideAfkPermission` returns `'always'`).

### 5. Session Persistence
The SDK writes sessions to `~/.claude/projects/<dir>/` by default. We will:
- Pre-generate a UUID and pass it as `sessionId` in options
- Use `persistSession: true` (default) so sessions can be resumed
- Use `resume: sessionId` for resumption

### 6. Progress Events
The SDK emits `SDKMessage` variants including:
- `SDKAssistantMessage` — assistant responses (map to `activity: 'assistant'`)
- `SDKToolProgressMessage` — tool execution progress (map to `activity: 'tool'`)
- `SDKResultMessage` — turn completion (success / error)
- `SDKSessionStateChangedMessage` — session status changes
- `SDKCompactBoundaryMessage` — context compaction

**Approach:** Create a `parseClaudeCodeEvent()` function similar to `parseOpenCodeEvent()` and `parseKimiEvent()` that maps SDK messages to `OpenCodeSessionProgressEvent`s.

### 7. Stale Detection & Recovery
The SDK's `Query` object exposes `interrupt()` to stop the current turn. We can implement stale detection using the same timeout logic as Kimi/OpenCode:
- Track last meaningful progress timestamp
- If timeout exceeded, call `query.interrupt()`
- Re-query with the stale recovery prompt

### 8. Sync Adapter
Claude Code reads skills from `~/.claude/skills/` and prompts from `~/.claude/prompts/` (based on observed config structure).

**Approach:** Create `ClaudeCodeSyncAdapter` following the existing `KimiSyncAdapter` / `OpenCodeSyncAdapter` pattern.

## Files to Modify / Create

### New Files
| File | Purpose |
|------|---------|
| `src/claude-code.ts` | `ClaudeCodeSessionExecutor`, `discoverClaudeCodeModels()`, message parsing, stale recovery |
| `src/sync/adapters/claude-code.ts` | `ClaudeCodeSyncAdapter` for skills/prompts sync |
| `tests/claude-code.test.ts` | Unit tests for executor, message parsing, model discovery |
| `tests/claude-code-agent-execution-provider.contract.test.ts` | Contract tests following existing provider patterns |

### Modified Files
| File | Changes |
|------|---------|
| `package.json` | Add `@anthropic-ai/claude-agent-sdk` dependency |
| `src/types.ts` | Add `'ClaudeCode'` to `LaunchPreferences.harness`, `LaunchPreferences.reviewerHarness`, `LaunchPlan.reviewerHarness` unions |
| `src/agent-execution-provider.ts` | Add `ClaudeCodeAgentExecutionProvider`, `detectClaudeCodeFailure()` |
| `src/provider-failure.ts` | Add `'claude-code-session-stale'` to `ProviderFailureKind`, `classifyProviderFailure()`, `detectClaudeCodeFailure()` |
| `src/cli.ts` | Add `discoverClaudeCodeModels()` to harness discovery, conditional executor/provider instantiation for Claude Code, preflight support |
| `src/interactive-launch.ts` | Add `'ClaudeCode'` to `LaunchWizardResult.harness` and `reviewerHarness` types |
| `src/runtime-store.ts` | Add `'ClaudeCode'` to harness validation in `readLaunchPreferences()`; fix `EXECUTION_PROVIDER` hardcoding bug to use actual harness |
| `src/launch-context-builder.ts` | Add `'ClaudeCode'` to reviewer harness type |
| `src/progress-line.ts` | Update provider name mapping to include `'claude-code'` |
| `src/sync/runner.ts` | Add `ClaudeCodeSyncAdapter` to sync runner |

## Implementation Details

### `src/claude-code.ts` — Core Executor

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { OpenCodeSessionExecutor, OpenCodeSessionProgressEvent, OpenCodePermissionRequest, OpenCodePermissionDecision } from './opencode.js';
import type { LaunchModel } from './types.js';

export async function discoverClaudeCodeModels(): Promise<LaunchModel[]> {
  const { startup } = await import('@anthropic-ai/claude-agent-sdk');
  const warm = await startup();
  try {
    const models = await warm.supportedModels();
    return models.map(m => ({
      id: `anthropic/${m.id}`,
      label: m.name || m.id,
    }));
  } finally {
    warm.close();
  }
}

export class ClaudeCodeSessionExecutor implements OpenCodeSessionExecutor {
  async run(input: {
    model: LaunchModel;
    prompt: string;
    title: string;
    agent?: string;
    sessionId?: string | null;
    workDir?: string;
    staleProgressTimeoutMs?: number;
    activeToolStaleTimeoutMs?: number;
    maxStaleRecoveries?: number;
    onProgress?: (event: OpenCodeSessionProgressEvent) => void;
    decidePermission?: (request: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision | null>;
  }): Promise<{sessionId?: string | null; output: string[]; terminalError?: string | null; finalMessageText?: string | null}> {
    // 1. Parse model ID (strip anthropic/ prefix)
    // 2. Generate or reuse session ID
    // 3. Call query() with options including model, sessionId/resume, cwd, permissionMode, canUseTool
    // 4. Consume async generator, map messages to progress events
    // 5. Implement stale detection with interrupt() + re-query
    // 6. Collect output lines, extract final assistant message, detect errors
  }
}
```

### Message Mapping Strategy

SDK Message → Progress Event:
- `SDKAssistantMessage` with text → `{kind: 'message', message: text, activity: 'assistant'}`
- `SDKToolProgressMessage` → `{kind: 'message', message: tool status, activity: 'tool', toolName, toolStatus}`
- `SDKResultMessage` (success) → turn completed signal
- `SDKResultMessage` (error) → terminal error extraction
- `SDKPermissionDeniedMessage` → `{kind: 'permission', ...}`
- `SDKCompactBoundaryMessage` → `{message: 'claude context compaction started/finished'}`
- `SDKSessionStateChangedMessage` → session status updates

### Permission Mapping

The SDK's `canUseTool` callback will be wired to always return `allow` (matching current AFK `decideAfkPermission` behavior). Future work can wire it to the actual `decidePermission` callback for interactive mode.

```typescript
canUseTool: async () => ({ decision: 'allow' }),
permissionMode: 'bypassPermissions',
allowDangerouslySkipPermissions: true,
```

### Stale Recovery

Use the same pattern as Kimi/OpenCode:
1. Track `lastMeaningfulProgressAt` and `activeTool` state
2. Race the message iterator against a timeout check
3. On timeout: call `query.interrupt()`, increment recovery counter
4. If recoveries <= max: re-call `query()` with `buildStaleRecoveryPrompt()`
5. If recoveries > max: return terminal error

### Sync Adapter

```typescript
export const ClaudeCodeSyncAdapter: SyncAdapter = {
  id: 'claude-code',
  assetCategories() {
    const configRoot = path.join(os.homedir(), '.claude');
    return [
      { name: 'skills', sourceRoot: 'artifacts/skills', destinationRoot: path.join(configRoot, 'skills'), extensions: ['.md'] },
      { name: 'prompts', sourceRoot: 'artifacts/prompts', destinationRoot: path.join(configRoot, 'prompts'), extensions: ['.md'] },
    ];
  },
};
```

## Testing Strategy

1. **Unit tests** (`tests/claude-code.test.ts`):
   - Model ID parsing (strip `anthropic/` prefix)
   - Message parsing (`parseClaudeCodeEvent`)
   - Failure detection (`detectClaudeCodeFailure`)

2. **Contract tests** (`tests/claude-code-agent-execution-provider.contract.test.ts`):
   - Follow the pattern in `tests/agent-execution-provider.contract.test.ts`
   - Mock the SDK's `query()` async generator
   - Verify provider correctly maps successful execution to `completed`
   - Verify failure detection, permission forwarding, session resumption

3. **Integration considerations**:
   - The SDK requires a real Claude Code installation and authentication
   - Tests should mock the SDK to avoid requiring credentials in CI

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SDK is brand new (v0.3.148) | API may change | Pin to exact version, monitor SDK releases, keep abstraction thin |
| SDK peer dependencies are heavy | Larger install footprint | Acceptable for first-party integration; SDK bundles native binaries optionally |
| No explicit `session.create()` API | Session IDs must be pre-generated | Pre-generate UUIDs and pass as `sessionId`; validate this works via testing |
| Model discovery requires subprocess startup | Slower wizard | Use `startup()` + `supportedModels()` + `close()`; cache results |
| Permission model mismatch | Complex mapping | Start with `bypassPermissions` + `allowDangerouslySkipPermissions: true` (matches current AFK yolo mode) |

## Rollout Plan

1. **Phase 1: Foundation** — Create `src/claude-code.ts` with executor, message parsing, and model discovery
2. **Phase 2: Provider wiring** — Add `ClaudeCodeAgentExecutionProvider`, update types, CLI, interactive launch
3. **Phase 3: Sync** — Add `ClaudeCodeSyncAdapter`, update sync runner
4. **Phase 4: Testing** — Add unit and contract tests
5. **Phase 5: Validation** — End-to-end test with a real Claude Code ticket

## Estimated Scope

- **New code:** ~400-500 lines (executor, message parsing, sync adapter)
- **Modified code:** ~100-150 lines across 8-10 files (type unions, CLI wiring, provider wrappers)
- **Tests:** ~200-300 lines
- **Complexity:** Medium — the SDK's async generator API is different from the request/response + SSE pattern used by OpenCode, but the abstraction layer handles most complexity
