# Golden Principles

These mechanical rules come from the approved harness design spec. They are intentionally enforceable and should be treated as review blockers unless a change explicitly updates the design spec.

1. Every exported TypeScript/TSX function has an explicit return type.
2. No `as any` casts in production TypeScript/TSX/JavaScript code; use precise types, generics, or validated unknown narrowing instead.
3. All async boundaries catch, propagate, or convert errors with actionable context; never silently swallow rejected promises or subprocess failures.
4. Shared types live in one canonical module and are imported rather than duplicated across commands, tests, and utilities.
5. Filesystem, subprocess, and path handling must be cross-platform; use language/runtime APIs instead of POSIX-only shell assumptions unless explicitly platform-gated.
6. Production code must not depend on test-only mocks, fixtures, or Bun test globals.
