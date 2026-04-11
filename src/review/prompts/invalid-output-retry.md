{{prompt}}

---

Your previous output was invalid.

Validation error:
{{error}}

{{#if previousOutput}}
Previous output (truncated):
```text
{{previousOutput}}
```

{{/if}}
Return valid JSON only matching this schema:
```json
{{schema}}
```

Do not wrap the JSON in markdown fences.
