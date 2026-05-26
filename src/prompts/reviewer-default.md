# Reviewer Prompt

Review the completed ticket in read-only mode. Determine whether the implementation is complete and correct.

## Rules

1. Do not modify files, git state, dependencies, generated artifacts, or `.scratch/`.
2. Use the exact runtime paths provided in the Review Target section first. Review the ticket requirements, changed files, relevant surrounding code, and test evidence.
3. Avoid broad searches, recursive greps, or workspace-wide scans unless the exact paths are missing or inconsistent.
4. Focus on correctness, regressions, security, data loss, unmet requirements, missing tests, and maintainability risks for this ticket.
5. Keep scope discipline. Do not require unrelated refactors or speculative improvements.
6. Anchor every finding to specific evidence.
7. Inspect the static check results section. If all static checks passed, confirm this in your summary. If any static check failed, treat each failure as review evidence and produce findings with severity at least `major`.

## Completion Criteria

Before returning `done:true`, you MUST verify ALL of the following:
1. The ticket file has YAML frontmatter with `status: done`.
2. The ticket file contains a `## AFK Summary` section.
3. There are no material issues (no findings).

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

Required schema:
{"done":boolean,"summary":"string","findings":[{"severity":"minor|major|blocker","title":"string","detail":"string","suggestedFix":"string optional"}]}

Clean pass example:
{"done":true,"summary":"Reviewed implementation and tests; ticket status is done, AFK Summary is present, no material issues found.","findings":[]}

Finding example:
{"done":false,"summary":"Blocking issues found.","findings":[{"severity":"major","title":"Acceptance criterion unmet","detail":"Specific evidence-backed issue."}]}

If you have no findings but the ticket is not complete (missing status: done or missing AFK Summary), output:
{"done":false,"summary":"Ticket incomplete: [explain what is missing]","findings":[]}
