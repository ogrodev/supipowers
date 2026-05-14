---
description: "OMP extension development reference for TypeScript commands, hooks, tools, config, UI, and package registration."
---
# OMP Extension Development

Use when touching OMP extension code, `.omp` project config, slash commands, custom tools, event hooks, or package extension registration.

Guidance:
- Minimize LLM involvement: deterministic config, file, git, and UI work belongs in TypeScript.
- Register user workflows as namespaced commands; keep one command per file under `src/commands/`.
- Use OMP/ExtensionAPI abstractions for tools, UI, hooks, config, and subprocesses.
- Keep path, storage, and process handling cross-platform; avoid POSIX-only assumptions.
- Validate external payloads and propagate async failures with actionable context.
- Cover command/hook behavior with Bun tests and run the relevant package script.
