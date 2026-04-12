---
name: code-review
description: Deep code review methodology for thorough quality assessment
---

# Code Review

Identify defects, security risks, and maintainability problems in code changes before they merge.

## Quick Reference

| Aspect | Detail |
|---|---|
| **Input** | PR diff, file contents, PR title/description |
| **Output** | Structured findings (see Finding Format below) |
| **Scope** | Changed lines + immediate context; follow references 1 level deep when a change touches a public API |
| **Skip** | Formatting, import order, whitespace — defer to linters |
| **Depth** | Read every changed line; skim unchanged context for broken assumptions |

## Finding Format

Each finding MUST follow this structure:

```
**[severity]** `file:line` — Description of the issue.
Suggestion: concrete fix or direction.
```

**Severity levels:**

| Level | Meaning | Gate |
|---|---|---|
| `error` | Bugs, security holes, data loss, crashes | MUST fix before merge |
| `warning` | Wrong abstraction, missing validation, performance trap | SHOULD fix |
| `info` | Naming, style, minor simplification | Nice to have |

## Review Procedure

Execute these phases in order. Each phase produces findings or nothing.

### Phase 1 — Understand Intent
Read the PR title, description, and linked issues. Determine what the change is supposed to do. If intent is unclear, report as `warning` before proceeding.

### Phase 2 — Correctness
For each changed function/block:
- Trace inputs through the logic. Identify domain boundaries (null, empty, zero, negative, max-length).
- For each boundary, verify the code handles or explicitly rejects it. Unhandled → `error`.
- Check return values: can a caller confuse a failure return with a success? Silent failures → `error`.

### Phase 3 — Security
At every system boundary (user input, HTTP params, DB queries, shell commands, file paths):
- Verify input is validated or sanitized before use. Missing → `error`.
- Check for secrets in code, logs, or error messages. Present → `error`.
- Verify auth checks exist for protected operations. Missing → `error`.

### Phase 4 — Performance
- Identify loops over collections: is work inside the loop that could be batched or hoisted? Report as `warning`.
- Look for N+1 patterns: a query inside a loop that iterates query results. Report as `warning`.
- Flag unbounded lists or payloads with no pagination/limit. Report as `warning`.

### Phase 5 — Maintainability
- Flag functions doing more than one job (needs "and" to describe) → `warning`.
- Flag duplicated logic across the diff (same pattern 2+ times) → `info`.
- Flag misleading names (function name promises X, body does Y) → `warning`.

### Phase 6 — Tests
- If the change adds behavior, verify a test covers the happy path. Missing → `warning`.
- If the change fixes a bug, verify a regression test exists. Missing → `warning`.
- Flag non-deterministic tests (time-dependent, random, order-dependent) → `warning`.

## Examples

### Bug: unhandled null at domain boundary

```ts
// PR diff
function getUser(id: string) {
  const row = db.query("SELECT * FROM users WHERE id = ?", [id]);
  return { name: row.name, email: row.email };
}
```

**Finding:**
```
**[error]** `src/users.ts:3` — `db.query` returns `null` when no row matches,
but the next line unconditionally accesses `.name` on the result.
Suggestion: Guard with `if (!row) return null` or throw a NotFoundError.
```

### Security: unsanitized input in shell command

```python
# PR diff
def export_report(filename):
    os.system(f"tar czf /tmp/{filename}.tar.gz /data/reports")
```

**Finding:**
```
**[error]** `reports/export.py:3` — `filename` is interpolated into a shell
command without sanitization. An attacker passing `; rm -rf /` exploits this.
Suggestion: Use `subprocess.run(["tar", "czf", ...])` with a list to avoid shell injection,
and validate `filename` against an allowlist pattern.
```

### N+1 query in loop

```ts
// PR diff
const orders = await db.orders.findMany({ where: { status: "open" } });
for (const order of orders) {
  const customer = await db.customers.findUnique({ where: { id: order.customerId } });
  order.customerName = customer.name;
}
```

**Finding:**
```
**[warning]** `src/orders.ts:2-5` — Each loop iteration issues a separate
DB query for the customer. With N open orders this is N+1 queries.
Suggestion: Use `include: { customer: true }` in the initial query, or
batch-fetch customers with `findMany({ where: { id: { in: customerIds } } })`.
```

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---|---|
| Report every finding with file, line, severity, and suggestion | Report vague findings without location or fix direction |
| Prioritize errors first, then warnings, then info | Bury a critical bug under 10 style nits |
| Read the full diff before writing findings | Review only the first file and stop |
| Verify claims by reading the referenced code | Assume a pattern is wrong without checking the implementation |
| Limit info-level findings to 5 max | Flood the review with cosmetic suggestions |

## Final Checklist

Before submitting your review, verify:
- [ ] Every `error` finding includes a concrete reproduction scenario or input
- [ ] Every finding has `file:line`, severity, description, and suggestion
- [ ] Findings are grouped by severity (errors first)
- [ ] No duplicate findings (same root cause reported once, not per-occurrence)
- [ ] If zero findings: explicitly state "No issues found" — do not return empty output
