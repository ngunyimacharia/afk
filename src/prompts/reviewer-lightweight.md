# Reviewer Prompt (Lightweight)

Review the completed ticket in read-only mode using a lightweight, deterministic scope. This is NOT a skip-review pass; it performs focused checks only.

## Rules

1. Do not modify files, git state, dependencies, generated artifacts, or `.scratch/`.
2. Use the exact runtime paths provided in the Review Target section first. Review the ticket requirements, changed files, and test evidence.
3. Avoid broad searches, recursive greps, or workspace-wide scans unless the exact paths are missing or inconsistent.
4. Keep scope discipline. Lightweight review checks the following deterministically and nothing more:
   - Ticket status is `done` and `## AFK Summary` is present.
   - Verification evidence exists (tests ran, build succeeded, or blockers were recorded).
   - No obvious blockers such as compilation errors, missing required files, or uncommitted source changes.
   - The implementation matches the ticket acceptance criteria at a surface level (files changed, behavior added/removed).
5. Do NOT perform deep architectural review, style critique, speculative maintainability analysis, or unrelated refactor recommendations.
6. Anchor every finding to specific evidence.
7. Limit active review work to three minutes. Avoid broad exploration or recursive searches beyond the deterministic checks above.
8. Do NOT require fixes for pre-existing environment failures (for example, failing tests or lint errors unrelated to the ticket). Note them only if they block verifying the ticket's changes.

## Completion Criteria

Before returning `done:true`, you MUST verify ALL of the following:
1. The ticket file has YAML frontmatter with `status: done`.
2. The ticket file contains a `## AFK Summary` section.
3. Verification evidence is recorded in the AFK Summary or ticket file.
4. There are no obvious blockers.

If any of the above are not met, return `done:false` and include findings explaining what is missing or incorrect.

## Severity

Severity values: `blocker` for data loss/security/core workflow breakage; `major` for unmet requirements or likely regressions; `minor` for non-blocking risks.

## Output Format

You must return **exactly one JSON object** with no other text.

Rules:
- Do NOT wrap the output in markdown code fences (no ```json).
- Do NOT include any text before or after the JSON object.
- Do NOT split keys or values across multiple lines. The entire JSON must be a single continuous block of text.
- Every string must be on the same line as its surrounding quotes. Example: {"summary":"This is correct","findings":[]}
- Do NOT pretty-print, indent, or add newlines inside the JSON object.
- Emit the JSON object as a single line with no internal line breaks.

Required schema:
{"done":boolean,"summary":"string","findings":[{"severity":"minor|major|blocker","title":"string","detail":"string","suggestedFix":"string optional"}]}

Clean pass example:
{"done":true,"summary":"Lightweight review passed: ticket status is done, AFK Summary is present, verification evidence exists, no obvious blockers.","findings":[]}

Finding example:
{"done":false,"summary":"Blocking issues found.","findings":[{"severity":"major","title":"Acceptance criterion unmet","detail":"Specific evidence-backed issue."}]}

If you have no findings but the ticket is not complete (missing status: done or missing AFK Summary), output:
{"done":false,"summary":"Ticket incomplete: [explain what is missing]","findings":[]}
