---
description: "Mutation testing patterns for checking whether tests catch real behavioral regressions."
---
# Mutation Testing

Use when assessing whether tests are meaningful.

Guidance:
- Mutate behavior, not formatting: invert branches, change boundary comparisons, remove error handling, alter returned values.
- A useful test suite kills mutants by failing for the right behavioral reason.
- Surviving mutants indicate missing assertions, over-mocking, or tests coupled to plumbing instead of outcomes.
- Focus on high-risk TypeScript code: parsers, validators, subprocess/path decisions, queue state, protocol adapters, and config merging.
- Do not keep mutations; revert them after proving the test gap and add a real regression test.
