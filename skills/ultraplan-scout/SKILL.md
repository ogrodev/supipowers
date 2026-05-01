---
name: ultraplan-scout
description: Codebase reconnaissance stage — maps reusable assets, integration points, conventions, and test patterns for each applicable stack
---

# UltraPlan Scout

Perform structured codebase reconnaissance and write findings as a JSON artifact. This stage runs after intake and before discover. It provides the factual foundation that all later stages depend on.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Inputs** | Intake artifact (provided by pipeline runner); repo access |
| **Output** | Scout artifact written via `ultraplan_scout_record` |
| **Tools** | `task`, `search`, `find`, `read`, `lsp` |
| **Scope** | Read-only. No edits. No inferences beyond what is observed. |
| **Storage tool** | `ultraplan_scout_record` — called exactly once |

## Reconnaissance Areas

For each stack marked `applicable` or `unknown` in the intake artifact, you MUST gather findings in all five areas below. For stacks marked `not-applicable`, skip them.

### 1. Reusable Assets

- Shared utilities, hooks, middleware, helper functions, base classes
- Existing abstractions in the relevant stack directory (e.g. `src/`, `app/`, `server/`, `infra/`)
- Package dependencies (read `package.json`, `pyproject.toml`, `go.mod`, etc.)

### 2. Integration Points

- Entry points, route handlers, API boundaries, event emitters, message queues
- Shared state surfaces (databases, caches, shared configs)
- Cross-stack interfaces (e.g. REST contracts, gRPC definitions, shared types)

### 3. Conventions

- Directory structure and file naming patterns
- Module/import patterns (path aliases, barrel exports, index files)
- Error handling patterns (Result types, thrown exceptions, error middleware)
- Coding style signals (linting config, tsconfig settings, eslint rules)

### 4. Existing Test Patterns

- Test runner and framework in use (Jest, Vitest, pytest, Go test, etc.)
- Test file location conventions (`__tests__/`, `.test.ts`, `_test.go`, etc.)
- Fixture and factory patterns
- Coverage configuration and thresholds

### 5. Gotchas

- Deprecated modules or patterns in active use
- Known workarounds or TODO comments in relevant files
- Circular dependencies or architectural debts visible from file structure
- Missing abstractions that multiple callers work around

## Investigation Strategy

Use `find` to map structure before reading individual files. Use `search` to locate patterns (error handlers, test factories, shared types). Use `read` for targeted file reads. Use `lsp` to follow type definitions and usages. Delegate broad parallel investigations to `task`.

Do not read entire files unless necessary. Read only the sections relevant to each reconnaissance area.

## Output Schema

Call `ultraplan_scout_record` exactly once with:

```
ultraplan_scout_record({
  stacks: {
    [stackId: "frontend" | "backend" | "infrastructure"]: {
      reusableAssets: string[],       // file paths or symbol names
      integrationPoints: string[],    // file paths or description strings
      conventions: {
        directories: string[],
        naming: string,
        errorHandling: string,
        importStyle: string
      },
      testPatterns: {
        runner: string,
        fileConvention: string,
        fixturePattern: string | null,
        coverageConfig: string | null
      },
      gotchas: string[]
    }
  },
  crossCuttingConcerns: string[]      // patterns that span multiple stacks
})
```

Report only what was observed. Use `null` for fields where no evidence was found.

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Investigate every applicable and unknown stack | Skip stacks because they seem unrelated to the goal |
| Report file paths as evidence for every asset and integration point | Make assertions without observed evidence |
| Use `null` for fields with no evidence | Invent conventions or test patterns |
| Parallelize independent stack investigations via `task` | Read files serially when parallel is safe |
| Call `ultraplan_scout_record` exactly once | Write narrative prose instead of structured JSON |

## Final Checklist

- [ ] Every applicable/unknown stack has entries in all five reconnaissance areas
- [ ] Every asset and integration point has a file path or symbol name as evidence
- [ ] `crossCuttingConcerns` captured where applicable
- [ ] `ultraplan_scout_record` called exactly once
- [ ] No edits made to any file
