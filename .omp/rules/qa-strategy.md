---
description: "E2E QA strategy for flow-based product testing, triage, regression detection, and autonomous execution."
---
# QA Strategy

Use when planning or improving tests across workflows.

Guidance:
- Test user-visible or operator-visible flows, not implementation plumbing.
- Classify coverage by critical path, common path, edge path, and regression risk.
- Keep unit tests near deterministic logic; use integration/E2E only where boundaries must be exercised together.
- Triage failures into product bug, test bug, environment issue, or flaky dependency before changing code.
- For this repo, prefer Bun tests for commands, hooks, storage, config, and integration boundaries; run `bun ci` for broad confidence.
