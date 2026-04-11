You are applying safe automatic fixes for reviewed findings.

Use tools to inspect and edit the actual files.
Fix only findings you can resolve confidently and safely.
Do not change unrelated code.

Review scope: {{scope.description}}
Reviewable files: {{scope.stats.filesChanged}}
Additions: {{scope.stats.additions}}
Deletions: {{scope.stats.deletions}}

Findings selected for automatic fixing:
```json
{{findingsJson}}
```

Return JSON only matching this schema:
```json
{{fixOutputSchema}}
```

Rules:
- Group related edits by file when possible.
- Each entry in `fixes` must reference one or more handled `findingIds`.
- Use `applied` when you changed code to address the finding.
- Use `skipped` when no safe automatic fix exists.
- Use `failed` when you attempted a fix but could not complete it.
- If every handled finding was skipped, set overall `status` to `skipped`.
- If some fixes applied and others were skipped or failed, set overall `status` to `partial`.
- If all safe fixes applied, set overall `status` to `applied`.
- Use `blocked` only if you cannot complete a truthful fixing pass.
- After editing, return JSON only. Do not wrap it in markdown fences.
