# ForgeCode source map

This is the shortest reading list that explains most of ForgeCode.

## Repo files

| File | Why it matters |
| --- | --- |
| `README.md:180-372` | Best high-level product overview: three usage modes, agents, skills, AGENTS.md, semantic search, shell integration. |
| `crates/forge_main/src/main.rs:58-128` | Real entrypoint: config load, cwd/sandbox resolution, UI init. |
| `crates/forge_main/src/ui.rs:298-383` | Interactive loop, direct-prompt handling, cache hydration. |
| `crates/forge_api/src/forge_api.rs:44-56` | Shows how infra/repo/services are assembled into a usable API. |
| `crates/forge_api/src/forge_api.rs:132-159` | Chat and compaction entrypoints exposed to the UI. |
| `crates/forge_app/src/app.rs:60-207` | Core chat pipeline: load conversation, resolve agent/provider, build prompts, resolve tools, install hooks, run orchestrator. |
| `crates/forge_app/src/orch.rs:195-439` | The real agent loop: request/response, tool calls, yield/completion, limits, hook lifecycle. |
| `crates/forge_repo/src/agents/forge.md:1-33` | Default implementation-agent behavior and tool budget. |
| `crates/forge_repo/src/agents/sage.md:1-24` | Read-only research agent. |
| `crates/forge_repo/src/agents/muse.md:1-25` | Planning agent. |
| `crates/forge_repo/src/agent.rs:12-25` | Documents agent source precedence: built-in, global, cwd. |
| `crates/forge_services/src/instructions.rs:6-46` | Shows AGENTS.md discovery from global/git-root/cwd. |
| `crates/forge_app/src/system_prompt.rs:68-133` | System prompt composition using tools, skills, environment, files, and custom rules. |
| `templates/forge-custom-agent-template.md:1-58` | The shared system-prompt frame all built-in agents inherit. |
| `crates/forge_app/src/user_prompt.rs:136-253` | User prompt rendering, terminal trace injection, attachments, resume behavior. |
| `crates/forge_domain/src/tools/catalog.rs:41-61` | Complete built-in tool inventory. |
| `crates/forge_app/src/tool_registry.rs:93-210` | Tool routing across built-ins, delegated agents, and MCP. |
| `crates/forge_app/src/tool_executor.rs:343-359` | Read-before-edit guardrail for patch/overwrite operations. |
| `crates/forge_domain/src/tools/descriptions/semantic_search.md:1-27` | Explicit evidence that semantic search is intended as the default discovery tool. |
| `crates/forge_domain/src/tools/descriptions/shell.md:1-47` | Explicit evidence that shell is constrained and specialized tools are preferred. |
| `crates/forge_services/src/context_engine.rs:253-276` | Semantic workspace query service. |
| `crates/forge_repo/src/context_engine.rs:191-276` | Remote gRPC search/index backend interface. |
| `crates/forge_app/src/agent_executor.rs:42-137` | Agent-as-tool / delegated-agent runtime. |
| `crates/forge_app/src/compact.rs:21-35` and `crates/forge_app/src/compact.rs:88-171` | Context summarization/compaction logic. |
| `crates/forge_app/src/hooks/pending_todos.rs:25-130` | End-of-turn reminder injection when outstanding todos remain. |
| `crates/forge_app/src/hooks/doom_loop.rs:12-29` and `crates/forge_app/src/hooks/doom_loop.rs:222-249` | Loop detection for repeated tool patterns. |
| `benchmarks/README.md:31-203` | Internal evaluation harness. |
| `benchmarks/evals/todo_write_usage/task.yml:1-18` | Planning enforcement eval. |
| `benchmarks/evals/read_over_cat/task.yml:8-31` | Tool-use anti-pattern eval. |
| `benchmarks/evals/search_over_find/task.yml:8-31` | Search-tool anti-pattern eval. |
| `benchmarks/evals/parallel_tool_calls/task.yml:8-18` | Parallel execution eval. |
| `benchmarks/evals/semantic_search_quality/task.yml:15-149` | Semantic-search quality eval. |

## Public URLs worth reading

| URL | Why it matters |
| --- | --- |
| https://www.tbench.ai/leaderboard/terminal-bench/2.0 | Current public leaderboard and scores. |
| https://forgecode.dev/blog/benchmarks-dont-matter/ | ForgeCode’s Part 1 explanation for the jump from ~25% to 78.4%. |
| https://forgecode.dev/blog/gpt-5-4-agent-improvements/ | ForgeCode’s Part 2 explanation for the jump to 81.8%. |
| https://forgecode.dev/docs/forge-services/ | Public description of the proprietary runtime layer behind the semantic/context/tool-correction story. |
| https://debugml.github.io/cheating-agents/ | External critique arguing some top ForgeCode runs were inflated by AGENTS.md leakage. |

## Fastest path to understanding

If you only have 20 minutes, read in this order:
1. `README.md:180-372`
2. `crates/forge_app/src/app.rs:60-207`
3. `crates/forge_app/src/orch.rs:195-439`
4. `crates/forge_repo/src/agents/forge.md:1-33`
5. `crates/forge_services/src/instructions.rs:6-46`
6. `benchmarks/evals/todo_write_usage/task.yml:1-18`
7. `benchmarks/evals/semantic_search_quality/task.yml:15-149`
8. https://forgecode.dev/blog/benchmarks-dont-matter/
9. https://forgecode.dev/blog/gpt-5-4-agent-improvements/
10. https://debugml.github.io/cheating-agents/

That sequence gives you:
- the product shape
- the runtime loop
- the default implementation-agent behavior
- AGENTS.md injection behavior
- the repo’s own benchmark-aware eval discipline
- ForgeCode’s public benchmark claims
- the most important external caveat
