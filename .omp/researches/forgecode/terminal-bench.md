# Why ForgeCode scores so high on Terminal Bench

This document answers the main research question directly.

## Bottom line

My best evidence-based answer is:

> ForgeCode scores high because it is heavily optimized around **agent-harness reliability**: non-interactive behavior, tool correctness, planning discipline, entry-point discovery, parallel execution, context control, and explicit verification.

That said, two caveats matter:
1. **The top public runs were not powered by the open-source client alone.** ForgeCode says the SOTA runtime layer was proprietary ForgeCode Services.
2. **A recent external audit argues some 81.8% ForgeCode leaderboard runs were inflated by AGENTS.md prompt leakage.** I did not independently replay those traces, but the auto-loading mechanism is real in the repo.

## 1. Publicly observable benchmark state

The current Terminal Bench 2.0 leaderboard lists ForgeCode at:
- rank 1: GPT-5.4, **81.8%**
- rank 2: Claude Opus 4.6, **81.8%**
- rank 5: Gemini 3.1 Pro, **78.4%**

Source: https://www.tbench.ai/leaderboard/terminal-bench/2.0.

ForgeCode’s own public posts claim the performance trajectory was:
- baseline: ~25%
- after non-interactive mode + tool-call naming + micro-evals: ~38%
- after enforced `todo_write`: 66%
- after subagent parallelization + progressive thinking + skill routing: 78.4%
- after more schema/verification tuning: 81.8%

Sources:
- https://forgecode.dev/blog/benchmarks-dont-matter/
- https://forgecode.dev/blog/gpt-5-4-agent-improvements/

## 2. The strongest explanation: ForgeCode optimizes the harness, not just the prompt

ForgeCode’s own benchmark posts are unusually clear: they do **not** frame the gain as “we found a better model.” They frame it as “we stopped triggering failure modes in the agent loop.”

That matches the repo.

### 2.1 Non-interactive mode removes benchmark-deadly chat behavior

ForgeCode says its initial harness failed because it behaved like a helpful chat assistant: it asked clarifying questions, waited for confirmation, and hedged when uncertain. In Terminal Bench, that burns turns and time budget.

Source: https://forgecode.dev/blog/benchmarks-dont-matter/.

Why I believe this is real:
- the repo is built around structured agents and templates, so runtime mode-switches are natural, not bolted on (`crates/forge_repo/src/agents/forge.md:1-33`, `crates/forge_app/src/system_prompt.rs:68-133`)
- ForgeCode explicitly distinguishes user-facing modes and agent roles in the README (`README.md:180-233`, `README.md:241-259`)

Assessment: **very likely one of the largest performance drivers**.

## 3. Tool-call reliability engineering is probably the second-biggest driver

Terminal Bench is tool-mediated. A model that picks the wrong tool, uses the right tool with the wrong JSON keys, or performs steps in the wrong order loses real time and often fails the task entirely.

ForgeCode’s benchmark posts say they attacked this directly:
- micro-evals for wrong tool / wrong args / wrong sequencing
- better tool and argument naming
- field-order changes in JSON schema (`required` before `properties`)
- flattening nested schemas
- explicit reminders when read output is truncated

Sources:
- https://forgecode.dev/blog/benchmarks-dont-matter/
- https://forgecode.dev/blog/gpt-5-4-agent-improvements/

The repo strongly supports that story:
- built-in typed tool catalog: `crates/forge_domain/src/tools/catalog.rs:41-61`
- tool registry + routing: `crates/forge_app/src/tool_registry.rs:93-210`
- read-before-edit guardrail: `crates/forge_app/src/tool_executor.rs:343-359`
- semantic search explicitly marked as default discovery tool: `crates/forge_domain/src/tools/descriptions/semantic_search.md:1-27`
- shell explicitly forbids `cat`, `find`, `grep`, `sed`, etc. when specialized tools exist: `crates/forge_domain/src/tools/descriptions/shell.md:1-47`

The repo’s internal evals reinforce exactly these behaviors:
- `benchmarks/evals/read_over_cat/task.yml:8-31`
- `benchmarks/evals/search_over_find/task.yml:8-31`
- `benchmarks/evals/parallel_tool_calls/task.yml:8-18`
- `benchmarks/evals/semantic_search_quality/task.yml:15-149`

Assessment: **very likely a major reason ForgeCode beats simpler harnesses using similar models**.

## 4. Mandatory planning and forced verification reduce “looks done” failures

ForgeCode publicly says two big benchmark improvements came from making planning and verification **enforced**, not optional:
- enforcing `todo_write` moved pass rate from 38% to 66%
- enforced reviewer-mode verification was the biggest single later improvement

Sources:
- https://forgecode.dev/blog/benchmarks-dont-matter/
- https://forgecode.dev/blog/gpt-5-4-agent-improvements/

Again, the repo matches the general direction:
- the default `forge` agent prompt pushes todo tracking very aggressively (`crates/forge_repo/src/agents/forge.md:47-58`)
- pending todos are surfaced again if the model tries to stop too early (`crates/forge_app/src/hooks/pending_todos.rs:25-130`)
- the orchestrator fires end hooks and can continue instead of yielding if new messages were injected (`crates/forge_app/src/orch.rs:406-429`)
- todo usage has a dedicated eval: `benchmarks/evals/todo_write_usage/task.yml:1-18`

The repo does not fully expose the exact “verification skill” described in the March 2026 blog posts, so that specific implementation looks at least partly outside the open-source tree. But the surrounding machinery is clearly present.

Assessment: **extremely plausible high-leverage factor**.

## 5. Semantic entry-point discovery matters more than raw context size

ForgeCode’s Part 1 benchmark writeup makes a strong claim: more context helps only after the agent finds the right starting file/function; otherwise it just explores the wrong region more thoroughly.

Source: https://forgecode.dev/blog/benchmarks-dont-matter/.

This lines up with what is in the repo:
- `sem_search` is a first-class tool (`crates/forge_domain/src/tools/catalog.rs:41-61`)
- it is recommended as the default discovery tool (`crates/forge_domain/src/tools/descriptions/semantic_search.md:1-27`)
- the tool executor runs search queries in parallel and deduplicates results (`crates/forge_app/src/tool_executor.rs:187-228`)
- the workspace service queries indexed file chunks (`crates/forge_services/src/context_engine.rs:253-276`)
- the backing repository talks to a remote workspace/indexing server over gRPC (`crates/forge_repo/src/context_engine.rs:191-276`)
- the README says indexing sends file content to the workspace server, defaulting to ForgeCode’s hosted API (`README.md:362-372`, `README.md:803-809`)

ForgeCode Services docs make the benchmark implication explicit: the context engine “start[s] the agent in the most relevant files and functions” and claims it uses far fewer tokens while staying fast. Source: https://forgecode.dev/docs/forge-services/.

Assessment: **very likely central to benchmark performance**.

## 6. Trajectory efficiency: parallel delegation, compaction, and reasoning control

Terminal Bench is time-bounded. ForgeCode’s public explanation is that “speed architecture” mattered as much as intelligence:
- subagent parallelization for low-complexity work
- progressive reasoning policy on the main agent
- skill routing

Source: https://forgecode.dev/blog/benchmarks-dont-matter/.

The open-source repo visibly contains part of that stack:
- delegated-agent execution: `crates/forge_app/src/agent_executor.rs:42-137`
- parallel execution for task-tool calls: `crates/forge_app/src/orch.rs:71-90`
- parallel delegated tasks via `join_all`: `crates/forge_app/src/tool_registry.rs:108-133`
- context compaction: `crates/forge_app/src/compact.rs:21-35`, `crates/forge_app/src/compact.rs:88-171`
- doom-loop detection: `crates/forge_app/src/hooks/doom_loop.rs:12-29`, `crates/forge_app/src/hooks/doom_loop.rs:222-249`

What is less directly visible in open source is the exact progressive reasoning controller described in the blog. ForgeCode explicitly says the relevant runtime layer was ForgeCode Services and proprietary for the 78.4% result. Source: https://forgecode.dev/blog/benchmarks-dont-matter/.

Assessment: **likely important, but partly hidden behind proprietary runtime behavior**.

## 7. The repo shows a benchmark-aware feedback loop, not just benchmark bragging

One of the most persuasive signs is not the leaderboard; it is the existence of narrow internal evals that turn benchmark lessons into repeatable checks.

ForgeCode ships a dedicated eval harness in `benchmarks/README.md:1-203` and small targeted suites in `benchmarks/evals/`. The evals are not generic smoke tests. They specifically encode desired agent behavior:
- use `read` instead of `cat`
- use search tools instead of shell `find`
- actually use semantic search for semantic tasks
- emit parallel tool calls
- keep todo state updated

That is the kind of process that reliably improves benchmark performance over time.

Assessment: **high-confidence process advantage**.

## 8. What is open vs what is proprietary

### Clearly visible in open source
- agent definitions and prompt templates
- tool catalog and tool descriptions
- delegated-agent runtime
- semantic-search client/service boundary
- context compaction and loop/todo hooks
- internal benchmark/eval harness
- AGENTS.md / skills / MCP integration

### Publicly claimed but not fully inspectable in the repo
- semantic entry-point discovery that starts the agent in the right files/functions
- automatic tool-call correction layer
- benchmark-time dynamic skill loading logic as described in ForgeCode Services docs/blogs
- automatic reasoning-budget control
- exact verification-skill enforcement used in March 2026 leaderboard pushes

Sources:
- https://forgecode.dev/blog/benchmarks-dont-matter/
- https://forgecode.dev/blog/gpt-5-4-agent-improvements/
- https://forgecode.dev/docs/forge-services/

This matters because the honest answer is not “the open-source repo alone explains 81.8%.” It explains **the architecture direction**. The public writeups say the actual SOTA runs used an additional proprietary runtime layer.

## 9. Critical caveat: benchmark leakage may explain part of the 81.8% result

A recent DebugML analysis argues ForgeCode’s top Terminal Bench 2 submissions used a scaffold that auto-loaded `AGENTS.md` files into the system prompt, and that some of those files contained literal answer keys. Their estimate is that replacing those traces with clean-scaffold traces would reduce the score from **81.8% to ~71.7%**.

Source: https://debugml.github.io/cheating-agents/.

Why this critique cannot be dismissed outright:
- ForgeCode **does** automatically discover `AGENTS.md` from global, git-root, and cwd locations (`crates/forge_services/src/instructions.rs:6-46`, `crates/forge_services/src/instructions.rs:68-89`)
- those instructions **are** injected into the system prompt as custom rules (`crates/forge_app/src/system_prompt.rs:85-114`)

What I did **not** verify in this research:
- the cited Terminal Bench traces themselves
- the exact benchmark task repos mentioned by DebugML
- whether ForgeCode later changed its harness in response

So the right conclusion is:
- the mechanism is real
- the external critique is credible enough to mention
- I cannot independently certify the exact score adjustment from this repo inspection alone

## My answer to the main question

If the question is:

> “How can ForgeCode score so high in Terminal Bench?”

my answer is:

1. **Because it is engineered like a benchmark harness, not just a terminal chat app.**
2. **Because it systematically removes common agent failure modes**: asking questions, drifting, miscalling tools, getting lost in large repos, stopping too early.
3. **Because it uses semantic retrieval, structured tools, planning state, delegation, and context controls as first-class runtime systems.**
4. **Because it turns benchmark lessons into smaller internal evals that lock behaviors in.**
5. **Because the very top scores likely depended on proprietary ForgeCode Services, not just the OSS repo.**
6. **And possibly because some leaderboard runs benefited from AGENTS.md leakage, if the DebugML audit is correct.**

The safest phrasing is:

> ForgeCode’s high score is mostly explained by strong harness engineering, but the public 81.8% number should be treated with caution because the winning scaffold was not fully open and has since been publicly challenged.
