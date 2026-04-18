# ForgeCode research

This folder documents the current essence of ForgeCode (`tailcallhq/forgecode`) and the most credible explanation for its strong Terminal Bench results.

## Executive summary

ForgeCode is a Rust-based terminal coding agent with three user-facing modes:
- interactive TUI (`forge`)
- one-shot CLI (`forge -p ...`)
- zsh shell interception via `:`-prefixed commands

Those modes all feed the same core runtime: a layered chat/orchestration system that loads agent definitions from Markdown, renders structured system and user prompts, routes typed tool calls, can delegate work to other agents, persists conversations, compacts context, and optionally uses a remote semantic-search/indexing service. The repo makes that architecture explicit in `README.md:180-233`, `crates/forge_main/src/main.rs:58-128`, `crates/forge_api/src/forge_api.rs:44-56`, and `crates/forge_app/src/app.rs:60-207`.

## Short answer: why does ForgeCode score so high on Terminal Bench?

The best evidence says: **because the team optimized the harness around benchmark failure modes, not just around model quality**.

High-confidence factors:
1. **Non-interactive execution**. ForgeCode publicly says its early benchmark failures came from chat-friendly behaviors like asking clarifying questions, and that a strict non-interactive mode was a major fix. Source: https://forgecode.dev/blog/benchmarks-dont-matter/.
2. **Tool-call reliability engineering**. They built micro-evals for tool misuse, tuned tool/argument naming, flattened schemas, and even changed JSON field ordering to reduce malformed calls. Sources: `benchmarks/README.md:31-40`, `benchmarks/evals/`, https://forgecode.dev/blog/benchmarks-dont-matter/, and https://forgecode.dev/blog/gpt-5-4-agent-improvements/.
3. **Mandatory planning and verification**. The repo strongly pushes `todo_write`, includes dedicated evals for it, and ForgeCode’s benchmark writeups say planning enforcement and verification enforcement were major gains. Sources: `crates/forge_repo/src/agents/forge.md:47-58`, `benchmarks/evals/todo_write_usage/task.yml:1-18`, https://forgecode.dev/blog/benchmarks-dont-matter/, https://forgecode.dev/blog/gpt-5-4-agent-improvements/.
4. **Fast entry-point discovery**. ForgeCode treats semantic search as a first-class capability and publicly says benchmark success depends on finding the right file/function early. Sources: `README.md:362-371`, `crates/forge_app/src/tool_executor.rs:187-228`, `crates/forge_services/src/context_engine.rs:253-276`, https://forgecode.dev/docs/forge-services/, https://forgecode.dev/blog/benchmarks-dont-matter/.
5. **Trajectory efficiency**. The orchestrator supports delegated agents, parallel sub-work, context compaction, retry handling, and loop detection; ForgeCode’s benchmark posts say subagent parallelization plus progressive reasoning control were part of the jump from 66% to 78.4%. Sources: `crates/forge_app/src/orch.rs:55-166`, `crates/forge_app/src/agent_executor.rs:42-137`, `crates/forge_app/src/compact.rs:21-35`, https://forgecode.dev/blog/benchmarks-dont-matter/.

## Important caveats

1. **The exact winning scaffold is not fully open source.** ForgeCode’s own blog says the runtime layer behind its 78.4% SOTA run was proprietary ForgeCode Services, and the later 81.8% writeup continues to attribute key gains to runtime engineering rather than to the OSS client alone. Sources: https://forgecode.dev/blog/benchmarks-dont-matter/, https://forgecode.dev/blog/gpt-5-4-agent-improvements/, https://forgecode.dev/docs/forge-services/.
2. **There is a credible external critique of the 81.8% leaderboard runs.** A recent DebugML analysis argues ForgeCode’s scaffold auto-loaded `AGENTS.md` files containing answer keys in some Terminal Bench tasks, and estimates the score would drop from 81.8% to about 71.7% under a clean scaffold. I did not independently replay those traces, but the mechanism is real in the repo: ForgeCode does auto-load `AGENTS.md` from multiple locations and injects those rules into the system prompt (`crates/forge_services/src/instructions.rs:6-46`, `crates/forge_services/src/instructions.rs:68-89`, `crates/forge_app/src/system_prompt.rs:85-114`). External source: https://debugml.github.io/cheating-agents/.

## Document map

- `architecture.md` — how ForgeCode is put together, from entrypoints to orchestration, tools, skills, and semantic search.
- `terminal-bench.md` — direct answer to the benchmark question, separating repo-observed facts, ForgeCode’s public claims, and external caveats.
- `source-map.md` — the smallest set of repo files and public URLs worth reading first.

## Public benchmark state observed during this research

The current Terminal Bench 2.0 leaderboard lists ForgeCode at:
- **81.8%** with GPT-5.4
- **81.8%** with Claude Opus 4.6
- **78.4%** with Gemini 3.1 Pro

Source: https://www.tbench.ai/leaderboard/terminal-bench/2.0.
