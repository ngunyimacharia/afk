# Plan: Integrate Claude Models into AFK via Anthropic SDK

## Context

AFK currently supports two agent harnesses: **OpenCode** and **Kimi**. Both are agent frameworks that expose a session-based SDK with built-in tool execution, permission handling, and progress streaming. The user wants to add **Claude models** (via the Anthropic API) as a third first-class harness option.

The core challenge is that the Anthropic SDK (`@anthropic-ai/sdk`) is a stateless Messages API, not an agent framework. To match the capabilities of OpenCode and Kimi, we must implement an agent loop with tool definitions, tool execution, message history management, and permission handling inside AFK.

## Recommended Approach

Build a `ClaudeSessionExecutor` that implements the existing `OpenCodeSessionExecutor` interface. The executor wraps the Anthropic SDK, maintains conversation state across turns, defines a minimal tool suite for AFK operations, and maps Anthropic streaming events to AFK progress events.

## Scope of Changes

### 1. New file: `src/claude.ts`

This is the bulk of the work. It must provide:

- **`discoverClaudeModels()`**: Returns a hardcoded list of available Claude models (e.g., `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Discovery requires an API key; if `ANTHROPIC_API_KEY` is absent, return an empty array.
- **`ClaudeSessionExecutor`**: Implements `OpenCodeSessionExecutor`.
  - **Session management**: Conversations are stateless in the Anthropic API. Persist message history to disk keyed by `sessionId` so that `sessionId` resume works. Use a temp dir under `.scratch/.opencode-afk-logs/claude-sessions/`.
  - **Tool suite**: Define and execute tools that map to AFK operations:
    - `bash` — execute shell commands in `workDir`
    - `read_file` — read file contents
    - `write_file` — write file contents
    - `apply_edit` — search-and-replace edit
    - `git_commit` — commit changes
    - `git_push` — push changes
  - **Agent loop**: Send the prompt with tool definitions. While the model returns `tool_use` blocks, execute them, feed results back as `tool_result` blocks, and repeat until a final `assistant` text response.
  - **Streaming**: Use the Anthropic streaming API. Emit `OpenCodeSessionProgressEvent` for:
    - Text chunks (throttle to last non-empty line, similar to Kimi/OpenCode)
    - Tool calls (`tool <name> running`)
    - Tool results (`tool <name> completed/failed`)
    - Errors
  - **Permissions**: The `decidePermission` callback is invoked before executing each tool call. Since AFK defaults to `autoApprove: true`, this is mostly for logging. Map the decision to allow/reject the tool call.
  - **Stale handling**: Implement the same stale-progress timeout logic as Kimi/OpenCode. If no meaningful progress event occurs within the timeout, interrupt the current turn and send a recovery prompt.
  - **Output extraction**: Collect all assistant text into `output` lines. The final assistant message text is `finalMessageText`. Terminal errors (API errors, tool failures) are surfaced as `terminalError`.

### 2. Update `src/types.ts`

Extend the harness literal unions to include `'Claude'`:
- `LaunchPreferences.harness`: `'OpenCode' | 'Kimi' | 'Claude'`
- `LaunchPreferences.reviewerHarness`: `'OpenCode' | 'Kimi' | 'Claude'`
- `LaunchPlan.reviewerHarness`: `'OpenCode' | 'Kimi' | 'Claude'`

### 3. Update `src/interactive-launch.ts`

Update `LaunchWizardResult` harness fields to include `'Claude'`.

### 4. Update `src/cli.ts`

- Import `discoverClaudeModels` and `ClaudeSessionExecutor` from `./claude.js`.
- Add Claude to harness discovery (lines 124-142):
  ```typescript
  try {
    const claudeModels = await discoverClaudeModels();
    if (claudeModels.length > 0) {
      availableHarnesses.push('Claude');
      harnessModelCache.Claude = claudeModels;
    }
  } catch {
    // Claude not available
  }
  ```
- Update `discoverModels` callback in the wizard to handle `'Claude'`.
- Update executor instantiation (lines 189-190) to include `Claude`:
  ```typescript
  const implementationExecutor = harness === 'Kimi' ? new KimiSessionExecutor() : harness === 'Claude' ? new ClaudeSessionExecutor() : new SDKOpenCodeSessionExecutor();
  ```
- Update reviewer executor instantiation similarly.
- Update `preflightSelectedModels` harness type parameter.
- Update progress line provider name (line 266).
- Update the final summary output to show `Claude` when selected.

### 5. Update `src/agent-execution-provider.ts`

Add `ClaudeAgentExecutionProvider` (following the same thin-wrapper pattern as `OpenCodeAgentExecutionProvider` and `KimiAgentExecutionProvider`):
- `providerName: 'claude'`
- `agentName: 'build'`
- `failureDetector: detectClaudeFailure`
- `sessionIdUnavailableReason: 'session id unavailable from claude'`

### 6. Update `src/provider-failure.ts`

- Add `'claude-session-stale'` to `ProviderFailureKind`.
- Update `classifyProviderFailure` to detect Claude-specific errors (`claude session stale`, `anthropic error:`, `overloaded_error`, `rate_limit_error`).
- Add `detectClaudeFailure(output: string[]): string | null` that scans output for Claude error patterns.

### 7. Update `src/progress-line.ts`

The provider name is already passed as an option; ensure `cli.ts` passes `'claude'` when the Claude harness is selected.

### 8. Update `package.json`

Add dependency:
```json
"@anthropic-ai/sdk": "^0.39.0"
```

## Critical Design Decisions

### Tool Safety
All tool execution runs in the ticket's worktree (`workDir`). The `bash` tool must reject commands that escape the worktree or execute destructive operations outside the sandbox. Follow the same permission model as the existing harnesses (auto-approve by default, `decidePermission` hook available).

### Session Persistence
Unlike OpenCode and Kimi, which manage sessions server-side, Claude sessions are local message histories. Store them as JSON files under `.scratch/.opencode-afk-logs/claude-sessions/{sessionId}.json`. On `run()` with a `sessionId`, load the history. On completion, save the updated history. This enables the same resume semantics AFK expects.

### Streaming Mapping
Anthropic's streaming API yields `content_block_delta`, `content_block_stop`, `message_delta`, etc. events. Map these to `OpenCodeSessionProgressEvent`:
- Text deltas → `activity: 'assistant'`
- `tool_use` start → `activity: 'tool', toolStatus: 'running'`
- `tool_result` → `activity: 'tool', toolStatus: 'completed'|'error'`
- API errors → `activity: 'session'`

### Model ID Format
Use flat model IDs (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) without a provider prefix. The `parseModelId` helper in `opencode.ts` splits on `/`; since Claude IDs have no slash, the executor should detect this and use the full ID as the model name.

## Verification

1. **Build**: `npm run build` (or `bun run build`) passes without TypeScript errors.
2. **Lint**: `npm run lint` passes.
3. **Discovery**: With `ANTHROPIC_API_KEY` set, running `afk` shows `Claude` in the harness list and lists Claude models.
4. **Preflight**: Selecting a Claude model runs the preflight prompt and receives an OK response.
5. **Reviewer Mode**: Run a ticket with reviewer harness set to `Claude`. The review completes and returns findings.
6. **Execution Mode**: Run a simple ticket (e.g., a documentation update) with implementation harness set to `Claude`. The agent reads files, writes changes, and the ticket completes.
7. **Session Resume**: Interrupt an in-progress Claude ticket and relaunch. The session resumes from the previous turn.
8. **Stale Recovery**: Verify that if Claude stops producing progress, the stale timeout triggers a recovery prompt.

## Estimated Complexity

High. The new `src/claude.ts` file will be roughly 400-600 lines (comparable to `src/kimi.ts` and `src/opencode.ts` combined) because it must implement both the SDK client management and the agent tool loop that OpenCode/Kimi provide for free. The remaining changes are mechanical type and wiring updates across ~6 files.
