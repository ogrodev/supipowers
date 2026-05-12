# Agent Harness Contract

This repository is an OMP-native TypeScript extension. Treat it as infrastructure code: correctness, cross-platform behavior, and maintainability outrank novelty.

## Required reading

- `docs/architecture.md` defines the layer table consumed by the layer-context-inject hook.
- `docs/golden-principles.md` defines the mechanical rules every change must preserve.
- `package.json` is the source of truth for local verification commands.

## Working rules

- Reuse existing modules and command patterns before adding new files.
- Keep shared domain types in `src/types.ts`; import them instead of duplicating shapes.
- Commands live one-per-file under `src/commands/` and should go through platform/config/storage abstractions.
- Storage, subprocesses, and paths must work on macOS, Linux, and Windows.
- Do not introduce test-only globals, fixtures, or mocks into production code.
- Do not swallow async failures. Propagate or convert them with actionable context.
- Prefer small, direct implementations over speculative abstractions.

## Imports and layering

- Keep imports grouped: Node built-ins, external packages, internal modules, then relative imports.
- Follow the layer table in `docs/architecture.md` for files covered by the harness guardrail.
- Files outside the layer table are not exempt from review; follow the nearest existing convention.
- Never bypass configured storage, config, or platform helpers with ad hoc filesystem or shell code.

## Verification

- Use `bun ci` as the canonical local quality command.
- A passing narrow test is not proof for unrelated behavior; run the gate that covers your change.
- If a harness queue or score artifact changes, inspect it before claiming the harness is healthy.
- CI must call `bun ci` instead of duplicating validation logic inline.

## Anti-slop guardrails

- The harness is active only when `.omp/supipowers/harness/marker.json` exists.
- Pre-edit duplicate probes, post-session sweeps, and layer-context injection are expected to be idempotent and marker-gated.
- Do not suppress duplicate, dead-code, or architecture findings. Fix the cause or leave a visible queue entry.

## When in doubt

Read `docs/architecture.md`, then `docs/golden-principles.md`, then the closest existing implementation; choose the smallest change that preserves the contract and prove it with the relevant command.
