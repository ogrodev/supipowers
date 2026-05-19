# supi-context-mode

Route high-output tool calls through sandboxed execution to protect the context window.

| Scope | Tool routing rules for supi-context-mode |
|-------|-----------------------------------------------------|
| Trigger | Active-aware; only currently active `ctx_*` tools can be used or named as enforced replacements |
| Goal | Prevent context flooding — a single unrouted command can dump 56 KB into context |
| Key rule | Blocked native tools are blocked only when an active `ctx_*` replacement exists |

## Tool Selection Hierarchy

Pick the highest-priority tool that fits the task:

| Priority | Tool | Use for |
|----------|------|---------|
| 1 — GATHER | `ctx_batch_execute(commands, queries)` | Primary tool. Runs all commands, auto-indexes, returns search results. ONE call replaces 30+ individual calls. |
| 2 — FOLLOW-UP | `ctx_search(queries: ["q1", "q2", ...])` | Query already-indexed content. Pass ALL questions as array in ONE call. |
| 2.5 — CACHE | `ctx_open_cached(handle, offset?, limit?)` | Open `cache://<sha>` handles when this tool is active. Returns bounded slices only. |
| 3 — PROCESSING | `ctx_execute(language, code)` / `ctx_execute_file(path, language, code)` | Sandbox execution. Only stdout enters context. |
| 4 — WEB | `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` | Fetch, chunk, index, query. Raw HTML never enters context. |
| 5 — INDEX | `ctx_index(content, source)` | Store content in FTS5 knowledge base for later search. |

## Blocked Commands

Blocked commands are intercepted only when their replacement `ctx_*` tool is active for the turn. Do NOT retry via Bash when a block reason names an active replacement.

| Blocked tool | Replacement |
|---|---|
| `curl` / `wget` in Bash | `ctx_fetch_and_index(url, source)` or `ctx_execute` with `fetch()` |
| Inline HTTP (`fetch('http`, `requests.get(`, etc.) in Bash | `ctx_execute(language, code)` — only stdout enters context |
| WebFetch / Fetch tool | `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` |
| Search tool | `ctx_search(queries)`, `ctx_batch_execute(commands, queries)`, or `ctx_execute(language: "shell", code: "grep ...")` |
| Find / Glob tool | `ctx_execute(language: "shell", code: "find ...")` or `ctx_batch_execute(commands, queries)` |

### Example: routing a search call

```
// WRONG — blocked, returns error
search(pattern: "TODO", paths: ["src/"])

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

When OMP's `shellMinimizer` is active, large bash output ends with a `[raw output: artifact://<id>]` footer. The footer is OMP's pointer to the full bytes — supipowers leaves it untouched. Recover the original with `read artifact://<id>`.

### Read

Reads are never blocked — OMP's native open/read tool preserves hashline anchors (e.g., `120th|content` after 14.4.1) for the edit contract. Copy edit anchors exactly, without the `|content` body, and never fabricate anchors. Edit payload lines must start with `~` immediately followed by intended file content; avoid a readability space after `~` unless that space is intentional file content. Large reads (>110 lines) are auto-compressed to head (80) + tail (30) with a `sel` hint.

For analysis-only reads where anchors are not needed, prefer `ctx_execute_file(path, language, code)` — only your printed summary enters context.

### Cache handles

When a prompt or prior output contains a `cache://<sha>` handle, open it with `ctx_open_cached(handle, offset?, limit?)` only if `ctx_open_cached` is active in the current tool catalog. Use bounded offsets/limits for follow-up reads; do not assume cached handles can be opened when the tool is inactive.

## Runtime Routing Guidance

The injected prompt is a compact, active-aware summary generated from the current active tool list. This static file is reference documentation; it is not injected wholesale.

## Output Constraints

- Write artifacts (code, configs, PRDs) to files — never inline. Return only: file path + 1-line description.
- When indexing, use descriptive `source` labels so others can `ctx_search(source: "label")` later.

## `ctx` Commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` tool, display full output verbatim |
| `ctx purge` | Call the `ctx_purge` tool to clear all indexed content |

## Checklist

- [ ] Used tool hierarchy (batch_execute > search > execute > fetch) — not raw Bash/Search/Find
- [ ] No blocked tool calls attempted
- [ ] Artifacts written to files, not returned inline
- [ ] Source labels are descriptive for later search
