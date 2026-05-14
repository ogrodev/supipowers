---
description: "Design guidance for coding harnesses, agent runtimes, tool catalogs, validation loops, and anti-slop guardrails."
---
# Harness Engineering

Use when designing or tuning agent harness behavior.

Guidance:
- Prefer deterministic enforcement over prompt-only policy for critical constraints.
- Tool catalogs should route by capability and cost; keep expensive or rare tools on demand.
- Every guardrail needs an observable signal, remediation path, and test.
- Runtime checks should be idempotent, marker-gated where appropriate, and safe across sessions.
- Evaluation should cover realistic failures: skipped verification, wrong tool choice, stale context, duplicate code, and layer violations.
