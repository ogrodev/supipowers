Return JSON only matching this schema:
```json
{{outputSchema}}
```

Rules:
- Tell the truth. If file, line, or suggestion is unknown, use `null` instead of guessing.
- Every finding must be actionable and grounded in the provided scope.
- `confidence` must be between 0 and 1.
- Use priority `P0`..`P3`, where `P0` is critical and `P3` is low urgency.
- Use `status: "failed"` when you found actionable issues.
- Use `status: "passed"` only when no actionable issues remain.
- Use `status: "blocked"` only if you cannot complete a truthful review.
- Do not wrap the JSON in markdown fences.
