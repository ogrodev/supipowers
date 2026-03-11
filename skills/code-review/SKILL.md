---
name: code-review
description: Deep code review methodology for thorough quality assessment
---

# Code Review Skill

Systematic approach to reviewing code changes.

## Review Checklist

### Correctness
- Does the code do what it claims?
- Are edge cases handled?
- Are error conditions handled?

### Security
- Input validation at system boundaries?
- SQL injection, XSS, command injection risks?
- Secrets in code or logs?
- Authentication/authorization checks?

### Performance
- Unnecessary loops or allocations?
- N+1 query patterns?
- Missing indexes for frequent queries?
- Large payloads or unbounded lists?

### Maintainability
- Clear naming (functions, variables, files)?
- Single responsibility per unit?
- Unnecessary abstractions or premature optimization?
- Comments where logic isn't self-evident?

### Testing
- Tests cover the happy path?
- Tests cover error/edge cases?
- Tests are deterministic (no flaky tests)?
- Test names describe the behavior?

## Severity Levels

- **error**: Must fix before merge. Bugs, security issues, data loss risks.
- **warning**: Should fix. Code quality, maintainability, minor issues.
- **info**: Nice to have. Style, naming suggestions, minor improvements.
