# ForgeCode architecture

This document focuses on what is directly observable in the `tailcallhq/forgecode` repository.

## 1. Top-level shape

ForgeCode is a multi-crate Rust workspace (`Cargo.toml:1-18`, `Cargo.toml:141-165`). The important layers are:

| Layer | Role | Key files |
| --- | --- | --- |
| `forge_main` | CLI/TUI shell, zsh-oriented UX, interactive loop | `crates/forge_main/src/main.rs:58-128`, `crates/forge_main/src/ui.rs:298-383` |
| `forge_api` | Public API facade that wires infra/repo/services into a usable app | `crates/forge_api/src/forge_api.rs:44-56`, `crates/forge_api/src/forge_api.rs:132-159` |
| `forge_app` | Session runtime: prompt construction, orchestration, tool routing, hooks, compaction | `crates/forge_app/src/app.rs:60-207`, `crates/forge_app/src/orch.rs:195-439` |
| `forge_services` | Concrete services for instructions, provider auth, tools, workspace sync/search, MCP, etc. | `crates/forge_services/src/instructions.rs:6-46`, `crates/forge_services/src/context_engine.rs:19-90` |
| `forge_repo` | Persistence/repository layer for agents, skills, workspace/index backends, config | `crates/forge_repo/src/agent.rs:12-25`, `crates/forge_repo/src/skill.rs:12-35`, `crates/forge_repo/src/context_engine.rs:83-118` |
| `forge_domain` | Shared domain model: agents, tools, conversations, compaction, schemas | `crates/forge_domain/src/agent.rs:105-169`, `crates/forge_domain/src/tools/catalog.rs:41-61` |
| `shell-plugin` | zsh plugin that intercepts `:` commands and captures recent terminal context | `shell-plugin/forge.plugin.zsh:5-35` |

The structure is opinionated: user interaction, orchestration, services, persistence, and domain types are separated cleanly enough that behavior changes can land in the right layer.

## 2. Session lifecycle

A normal session flows like this:

1. `main()` reads config, resolves working directory / sandbox, and initializes the UI (`crates/forge_main/src/main.rs:58-128`).
2. `UI::run_inner()` decides between subcommands, direct prompt mode, piped input mode, or the interactive prompt loop (`crates/forge_main/src/ui.rs:298-383`).
3. `ForgeAPI::chat()` looks up the active agent and delegates to `ForgeApp::chat()` (`crates/forge_api/src/forge_api.rs:132-142`).
4. `ForgeApp::chat()`:
   - loads the current conversation
   - resolves the agent and provider
   - lists files
   - resolves system tools
   - renders the system prompt
   - renders the user prompt
   - applies tunable parameters
   - installs hooks
   - constructs the orchestrator
   - runs the chat loop and persists the conversation at the end
   (`crates/forge_app/src/app.rs:67-206`)
5. `Orchestrator::run()` loops until completion or an explicit yield, streaming model output, dispatching tools, appending tool results back into context, enforcing request/error limits, and firing lifecycle hooks (`crates/forge_app/src/orch.rs:195-439`).

The important architectural point: ForgeCode is not a thin wrapper around model calls. It is an agent runtime with its own loop, state, hooks, and behavioral policies.

## 3. Built-in agents are Markdown-backed

ForgeCode’s default agents are stored as embedded Markdown files with YAML frontmatter:
- `crates/forge_repo/src/agents/forge.md:1-33`
- `crates/forge_repo/src/agents/sage.md:1-24`
- `crates/forge_repo/src/agents/muse.md:1-25`

The loader in `crates/forge_repo/src/agent.rs:12-25` and `crates/forge_repo/src/agent.rs:71-106` merges:
1. built-ins
2. global custom agents
3. project-local agents

with precedence `cwd > global > built-in` (`crates/forge_repo/src/agent.rs:19-24`, `crates/forge_repo/src/agent.rs:66-68`).

That matters because ForgeCode’s behavior is not only encoded in Rust. A large part of it is encoded in versioned agent definition files:
- `forge` = implementation agent
- `sage` = research agent
- `muse` = planning agent

The zsh/TUI layer exposes those agents directly (`README.md:241-259`, `crates/forge_main/src/ui.rs:2010-2017`).

## 4. Prompt assembly is highly structured

### System prompt

`SystemPrompt::add_system_message()` composes the system prompt from:
- environment information
- file lists
- file-extension statistics from `git ls-files`
- tool definitions
- skill inventory
- model capability flags
- custom instructions
- template partials
(`crates/forge_app/src/system_prompt.rs:68-133`)

The main template is `templates/forge-custom-agent-template.md:1-58`. It injects:
- system information (`templates/forge-partial-system-info.md:1-15`)
- tool usage instructions
- project guidelines from `AGENTS.md`
- skill instructions (`templates/forge-partial-skill-instructions.md:1-45`)

### Custom instructions (`AGENTS.md`)

ForgeCode automatically discovers `AGENTS.md` from:
1. the base/global path
2. the git root
3. the current working directory

as implemented in `crates/forge_services/src/instructions.rs:6-46`, then caches and injects those files as custom rules (`crates/forge_services/src/instructions.rs:68-89`, `crates/forge_app/src/system_prompt.rs:85-114`).

### User prompt

`UserPromptGenerator` adds more structure on the user side:
- separate task vs feedback shaping
- current date
- terminal command trace when available
- existing todos when resuming a session
- piped stdin as droppable context
- file attachments inferred from `@[path]`
(`crates/forge_app/src/user_prompt.rs:34-59`, `crates/forge_app/src/user_prompt.rs:61-109`, `crates/forge_app/src/user_prompt.rs:136-253`)

This is a bigger deal than it looks. ForgeCode is continuously shaping the model’s working context, not just passing raw user text through.

## 5. Terminal UX is part of the product, not a wrapper

The shell plugin is first-class. `shell-plugin/forge.plugin.zsh:5-35` wires together:
- syntax highlighting
- terminal context capture
- completion
- action handlers
- the main dispatcher

The README calls the zsh `:` prefix system the fastest day-to-day mode (`README.md:214-259`). The terminal context subsystem records recent commands, exit codes, and timestamps via environment variables, then turns them back into structured prompt context (`crates/forge_app/src/terminal_context.rs:7-24`, `crates/forge_app/src/terminal_context.rs:26-94`).

In other words, ForgeCode is designed as a terminal-native agent, not a web chat bolted onto a terminal.

## 6. Tooling model: typed tools, delegated agents, MCP

The built-in tool universe lives in `ToolCatalog` (`crates/forge_domain/src/tools/catalog.rs:41-61`). It includes:
- structured file reads/writes/patches/removes/undo
- regex search
- semantic search
- shell
- fetch
- plan
- skill
- todo_write / todo_read
- task (delegated agent execution)

`ToolRegistry::call_inner()` routes calls to one of three execution paths (`crates/forge_app/src/tool_registry.rs:93-210`):
1. built-in Forge tools
2. other agents as tools
3. MCP tools

### Notable guardrails

ForgeCode’s tool execution is unusually constrained:
- read-before-edit enforcement for patch and overwrite write operations (`crates/forge_app/src/tool_executor.rs:343-359`)
- per-tool timeouts (`crates/forge_app/src/tool_registry.rs:45-61`)
- policy/permission checks in restricted mode (`crates/forge_app/src/tool_registry.rs:63-91`, `crates/forge_app/src/tool_registry.rs:140-153`)
- modality validation for image reads (`crates/forge_app/src/tool_registry.rs:155-166`)

The tool descriptions are also benchmark-conscious. Examples:
- semantic search is explicitly declared the default discovery tool (`crates/forge_domain/src/tools/descriptions/semantic_search.md:1-27`)
- shell explicitly forbids using `cd`, `cat`, `grep`, `find`, `sed`, `awk`, or `echo` when dedicated tools exist (`crates/forge_domain/src/tools/descriptions/shell.md:1-47`)
- todo tracking is described as mandatory for complex multi-step tasks (`crates/forge_domain/src/tools/descriptions/todo_write.md:20-39`, `crates/forge_domain/src/tools/descriptions/todo_write.md:162-187`)

### Agent delegation

The `task` tool is not metaphorical. It spawns other agents and can run delegated tasks concurrently (`crates/forge_app/src/tool_registry.rs:108-133`). `AgentExecutor::execute()` creates/reuses conversations for delegated agents and streams their results back as tool output (`crates/forge_app/src/agent_executor.rs:42-137`).

That gives ForgeCode a built-in multi-agent execution model.

## 7. Semantic search is real, and it is remote-backed

ForgeCode’s README makes semantic workspace indexing/search a headline feature (`README.md:362-371`). The implementation path is:
- `sem_search` tool execution in `crates/forge_app/src/tool_executor.rs:187-228`
- workspace service in `crates/forge_services/src/context_engine.rs:253-276`
- remote gRPC repository in `crates/forge_repo/src/context_engine.rs:191-276`

Observations:
- search works over indexed file chunks, not plain grep (`crates/forge_repo/src/context_engine.rs:197-276`)
- the default workspace/indexing server is ForgeCode’s hosted API (`README.md:371-372`, `README.md:803-809`)
- the open-source repo exposes the client/service boundary, but not the full server internals

This is one of the main places where “open-source agent” and “open-source leaderboard harness” diverge.

## 8. Context management is a core subsystem

ForgeCode has explicit context-protection and drift-control features:
- configurable compaction thresholds and strategies (`crates/forge_domain/src/compact/compact_config.rs`)
- compaction hook (`crates/forge_app/src/hooks/compaction.rs:7-50`)
- context summarization that trims redundant operations and preserves reasoning continuity (`crates/forge_app/src/compact.rs:21-35`, `crates/forge_app/src/compact.rs:88-171`)
- doom-loop detection for repeated tool patterns (`crates/forge_app/src/hooks/doom_loop.rs:12-29`, `crates/forge_app/src/hooks/doom_loop.rs:222-249`)
- pending-todo reminders at end-of-turn when the model tries to stop too early (`crates/forge_app/src/hooks/pending_todos.rs:25-130`)
- shell/fetch truncation to temp files so the model does not drown in output (`crates/forge_app/src/tool_executor.rs:68-113`)

This is a runtime explicitly designed to keep long tool-using sessions on track.

## 9. Skills are a first-class routing layer

Skills are loaded from:
1. built-ins
2. global skills
3. `~/.agents/skills`
4. project-local `.forge/skills`

with precedence `cwd > agents > global > built-in` (`crates/forge_repo/src/skill.rs:12-35`, `crates/forge_repo/src/skill.rs:77-111`).

Built-in skills currently include:
- `create-skill`
- `execute-plan`
- `github-pr-description`
(`crates/forge_repo/src/skill.rs:45-66`)

The system prompt instructs agents to check the available skill list before attempting a task directly (`templates/forge-partial-skill-instructions.md:1-45`).

## 10. ForgeCode benchmarks itself on agent behavior, not just end-to-end pass rate

The `benchmarks/` directory is a dedicated eval harness, not a demo folder:
- framework overview: `benchmarks/README.md:31-40`, `benchmarks/README.md:57-100`
- eval suites: `benchmarks/evals/`

Representative behavior checks:
- `benchmarks/evals/todo_write_usage/task.yml:1-18` enforces todo usage
- `benchmarks/evals/parallel_tool_calls/task.yml:1-18` checks for parallel tool calls
- `benchmarks/evals/read_over_cat/task.yml:8-31` forbids reading files through `cat`
- `benchmarks/evals/search_over_find/task.yml:8-31` forbids using shell `find` instead of search tools
- `benchmarks/evals/semantic_search_quality/task.yml:15-149` checks both `sem_search` usage and result quality

This is one of the clearest signals in the repo: the team treats benchmark failures as specific behavioral regressions to be turned into smaller evals.

## Architecture takeaway

ForgeCode’s essence is not “a CLI around an LLM.” It is:
- a terminal-native UX layer
- a Markdown-configured agent system
- a structured prompt-construction engine
- a typed tool runtime with strong guardrails
- optional remote semantic retrieval
- explicit context/trajectory management
- internal evals that try to freeze desired agent behaviors into repeatable tests

That combination is exactly the kind of architecture that can outperform a simpler harness using the same underlying model.
