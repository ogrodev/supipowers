# supi-context-mode

Route high-output tool calls through sandboxed execution to protect the context window.

| Scope | Tool routing rules for supi-context-mode MCP tools |
|-------|-----------------------------------------------------|
| Trigger | Always active when supi-context-mode MCP tools are available |
| Goal | Prevent context flooding — a single unrouted command can dump 56 KB into context |
| Key rule | Blocked tools return errors; use sandbox equivalents instead |

## Tool Selection Hierarchy

Pick the highest-priority tool that fits the task:

| Priority | Tool | Use for |
|----------|------|---------|
| 1 — GATHER | `ctx_batch_execute(commands, queries)` | Primary tool. Runs all commands, auto-indexes, returns search results. ONE call replaces 30+ individual calls. |
| 2 — FOLLOW-UP | `ctx_search(queries: ["q1", "q2", ...])` | Query already-indexed content. Pass ALL questions as array in ONE call. |
| 3 — PROCESSING | `ctx_execute(language, code)` / `ctx_execute_file(path, language, code)` | Sandbox execution. Only stdout enters context. |
| 4 — WEB | `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` | Fetch, chunk, index, query. Raw HTML never enters context. |
| 5 — INDEX | `ctx_index(content, source)` | Store content in FTS5 knowledge base for later search. |

## Blocked Commands

Blocked commands are intercepted and replaced with an error. Do NOT retry via Bash.

| Blocked tool | Replacement |
|---|---|
| `curl` / `wget` in Bash | `ctx_fetch_and_index(url, source)` or `ctx_execute` with `fetch()` |
| Inline HTTP (`fetch('http`, `requests.get(`, etc.) in Bash | `ctx_execute(language, code)` — only stdout enters context |
| WebFetch / Fetch tool | `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` |
| Grep tool | `ctx_search(queries)`, `ctx_batch_execute(commands, queries)`, or `ctx_execute(language: "shell", code: "grep ...")` |
| Find / Glob tool | `ctx_execute(language: "shell", code: "find ...")` or `ctx_batch_execute(commands, queries)` |

### Example: routing a grep call

```
// WRONG — blocked, returns error
grep(pattern: "TODO", path: "src/")

// CORRECT — runs in sandbox, only printed summary enters context
ctx_execute(language: "shell", code: "grep -rn TODO src/")

// BEST — indexes output and returns search results in one call
ctx_batch_execute(
  commands: [{ label: "TODOs", command: "grep -rn TODO src/" }],
  queries: ["TODO fixme priority"]
)
```

## Redirected Tools

### Bash

Bash is for commands producing <20 lines: `git`, `mkdir`, `rm`, `mv`, `ls`, `npm install`, `pip install`.

For everything else:
- `ctx_batch_execute(commands, queries)` — multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — sandbox, only stdout enters context

### Read

Reads are never blocked — OMP's native read tool preserves hashline anchors (`N#XX`) for the edit contract. Large reads (>110 lines) are auto-compressed to head (80) + tail (30) with a `sel` hint.

For analysis-only reads where anchors are not needed, prefer `ctx_execute_file(path, language, code)` — only your printed summary enters context.

## Subagent Routing

The routing block is automatically injected into subagent prompts. Bash-type subagents are upgraded to general-purpose for MCP access. You do NOT need to manually instruct subagents about context-mode.

## Output Constraints

- Write artifacts (code, configs, PRDs) to files — never inline. Return only: file path + 1-line description.
- When indexing, use descriptive `source` labels so others can `ctx_search(source: "label")` later.

## `ctx` Commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call `ctx_stats` MCP tool, display full output verbatim |
| `ctx doctor` | Call `ctx_doctor` MCP tool, run returned shell command, display as checklist |
| `ctx upgrade` | Call `ctx_upgrade` MCP tool, run returned shell command, display as checklist |

## Checklist

- [ ] Used tool hierarchy (batch_execute > search > execute > fetch) — not raw Bash/Grep/Find
- [ ] No blocked tool calls attempted
- [ ] Artifacts written to files, not returned inline
- [ ] Source labels are descriptive for later search
