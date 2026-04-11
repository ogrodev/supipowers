{
  "findings": [
    {
      "id": "F001",
      "title": "Missing null check on user input",
      "severity": "error",
      "priority": "P1",
      "confidence": 0.85,
      "file": "src/auth.ts",
      "lineStart": 42,
      "lineEnd": 45,
      "body": "The code dereferences `userId` without validating that it exists.",
      "suggestion": "Add a guard that rejects nullish `userId` before use.",
      "agent": "correctness",
      "validation": {
        "verdict": "confirmed",
        "reasoning": "The null guard is missing at the referenced call site.",
        "validatedBy": "validator",
        "validatedAt": "2026-04-11T14:30:22.000Z"
      }
    },
    {
      "id": "F002",
      "title": "Location could not be determined confidently",
      "severity": "warning",
      "priority": "P3",
      "confidence": 0.32,
      "file": null,
      "lineStart": null,
      "lineEnd": null,
      "body": "Use null for unknown location fields instead of guessing.",
      "suggestion": null,
      "agent": "correctness"
    }
  ],
  "summary": "Found 2 review findings.",
  "status": "failed"
}
