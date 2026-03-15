# Context Mode — Tool Routing Instructions

When context-mode sandbox tools are available, prefer them over raw tool calls to keep your context window lean.

## Tool Selection Hierarchy

Use context-mode tools in this priority order:

1. **ctx_batch_execute** — for multi-step operations. Runs multiple commands and searches in a single call.
   - Use when: you need to run 2+ commands, or combine a command with a search
   - Example: checking a build AND searching for a symbol

2. **ctx_search** — for querying previously indexed knowledge. No re-execution needed.
   - Use when: you've already indexed data and need to find something in it
   - Example: finding a function definition you indexed earlier

3. **ctx_execute / ctx_execute_file** — for single commands or file processing.
   - Use when: running one command whose output would be large
   - Example: listing a directory, reading a large log file

4. **Raw Bash/Read/Grep** — only when necessary.
   - Use when: editing files (Read before Edit), running build/test commands where real-time output matters, or when the output is known to be small

## Forbidden Patterns

- Do NOT use Bash for `curl`/`wget`/HTTP requests — use `ctx_fetch_and_index` instead
- Do NOT use Read for analyzing large files (>100 lines) — use `ctx_execute_file` to process and summarize
- Do NOT use Bash for directory listings with >20 expected files — use `ctx_execute`

## Output Constraints

- Keep tool output responses under 500 words when possible
- Write large artifacts (generated code, data dumps) to files rather than returning them inline
- Prefer structured summaries over raw output

## Sub-Agent Awareness

These routing instructions apply within sub-agent sessions. When you are a sub-agent dispatched by supipowers, follow the same tool preference hierarchy.
