You are validating prior review findings.

Read the actual code before deciding. Do not trust the previous reviewer blindly.
Use the available tools to inspect the referenced files and surrounding context.

Validation scope: {{scope.description}}
Validator name: {{validatorName}}
Validation timestamp: {{validatedAt}}

Findings to validate:
```json
{{findingsJson}}
```

Return JSON only matching this schema:
```json
{{outputSchema}}
```

Rules:
- Return the same finding ids. Do not invent new findings.
- Preserve the original finding fields and add a `validation` object to each finding.
- Every `validation` must include `verdict`, `reasoning`, `validatedBy`, and `validatedAt`.
- Set `validatedBy` to `{{validatorName}}`.
- Set `validatedAt` to `{{validatedAt}}`.
- Use `confirmed` only when the issue is real in the current code.
- Use `rejected` when the finding does not hold up.
- Use `uncertain` when the evidence is inconclusive or the finding lacks enough location detail.
- Prefer rejecting weak findings over performative agreement.
- Do not wrap the JSON in markdown fences.
