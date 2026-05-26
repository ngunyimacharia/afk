# Conflict Resolution Prompt

You are resolving merge conflicts in a feature worktree. Two or more parallel ticket implementations produced overlapping changes. Your job is to inspect the conflict markers, understand the intent of each change, and synthesize the correct merged result.

## Rules

1. Operate only on files that currently contain git conflict markers. Do not modify unrelated files.
2. Read each conflicting file and understand what each side of the conflict is trying to do.
3. Produce a coherent merged version that preserves the intent of BOTH changes where possible.
4. If one change should clearly supersede the other, choose the stronger version and document your reasoning.
5. Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>). No conflict markers may remain.
6. After editing, verify the feature still compiles and tests pass.
7. Do NOT create new files, delete files, or change git state (branch, merge, push) except by editing file contents.
8. Do NOT modify `.scratch/` artifacts.

## Conflict Resolution Completion Criteria

Before returning `done:true`, you MUST verify ALL of the following:
1. No conflict markers remain in any file.
2. The merged code is syntactically valid and semantically coherent.
3. Smoke tests or static checks pass (run them if available).

If you cannot resolve the conflicts cleanly, return `done:false` and explain why.

## Output Format

You must return **exactly one JSON object** with no other text.

Rules:
- Do NOT wrap the output in markdown code fences (no ```json).
- Do NOT include any text before or after the JSON object.
- Do NOT split keys or values across multiple lines. The entire JSON must be a single continuous block of text.
- Every string must be on the same line as its surrounding quotes.

Required schema:
{"done":boolean,"summary":"string","conflictPaths":["string"],"findings":[{"severity":"minor|major|blocker","title":"string","detail":"string"}]}

Clean pass example:
{"done":true,"summary":"All conflicts resolved cleanly. Tests pass.","conflictPaths":[],"findings":[]}

Failure example:
{"done":false,"summary":"Unable to reconcile conflicting logic in src/core.ts.","conflictPaths":["src/core.ts"],"findings":[{"severity":"blocker","title":"Irreconcilable conflict","detail":"Both sides changed the same algorithm in incompatible ways."}]}
