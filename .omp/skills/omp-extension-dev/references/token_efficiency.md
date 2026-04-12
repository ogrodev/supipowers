# Token Efficiency Guide

This is the most important reference for OMP extension development. A well-designed extension handles as much as possible through TypeScript logic and UI primitives, reserving LLM involvement for tasks that genuinely require natural language understanding.

## Table of Contents
- [The Core Principle](#the-core-principle)
- [Decision Tree](#decision-tree)
- [What Doesn't Need the LLM](#what-doesnt-need-the-llm)
- [What Genuinely Needs the LLM](#what-genuinely-needs-the-llm)
- [Patterns for Token-Efficient Extensions](#patterns-for-token-efficient-extensions)
- [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
- [Real-World Comparison](#real-world-comparison)

---

## The Core Principle

Every token sent to the LLM costs time and money. The goal is not to avoid the LLM entirely — it's to use it surgically. Do the deterministic work first, then hand the LLM a focused, preprocessed prompt with only the context it needs.

**Think of it like cooking:** You don't ask a chef to wash vegetables, peel potatoes, boil water, AND cook the meal. You prep everything, then hand the chef exactly what they need to do the creative work.

## Decision Tree

When building any feature, ask yourself in this order:

```
1. Can the entire operation be done without the LLM?
   YES → Use pi.exec(), ctx.ui.*, file I/O, config APIs
   NO  → Continue to 2

2. Can parts of it be done without the LLM?
   YES → Do those parts in TypeScript, then send a focused prompt
   NO  → Continue to 3

3. Can you preprocess the input to reduce what the LLM needs to see?
   YES → Filter, summarize, or structure the data before sending
   NO  → Continue to 4

4. Can you decide AT RUNTIME whether the LLM is needed?
   YES → Add a complexity gate: simple cases handled in TS, complex cases go to LLM
   NO  → Send to LLM as-is (this should be rare)
```

## What Doesn't Need the LLM

These operations should NEVER go through the LLM:

| Operation | Use Instead |
|---|---|
| Get list of changed files | `pi.exec("git", ["diff", "--name-only"])` |
| Read file contents | `pi.exec("cat", [path])` or Node.js `fs` |
| Get current branch | `pi.exec("git", ["branch", "--show-current"])` |
| Count lines/files | `pi.exec("wc", [...])` or compute in TS |
| Parse JSON/YAML | Import a parser library |
| Select from a list | `ctx.ui.select()` |
| Yes/No confirmation | `ctx.ui.confirm()` |
| Get text input | `ctx.ui.input()` |
| Toggle a mode/setting | `pi.setActiveTools()`, `pi.setModel()`, etc. |
| Show status/progress | `ctx.ui.notify()`, `ctx.ui.setStatus()` |
| Run tests | `pi.exec("npm", ["test"])` |
| Format/lint code | `pi.exec("npx", ["prettier", "--write", file])` |
| Check if file exists | Node.js `fs.existsSync()` |
| Read configuration | Node.js `fs.readFileSync()` + JSON.parse |

## What Genuinely Needs the LLM

These tasks benefit from LLM involvement:

| Task | Why LLM Is Needed |
|---|---|
| Code review (finding bugs, style issues) | Requires understanding code semantics |
| Generating code from description | Natural language → code translation |
| Explaining code | Requires understanding intent and patterns |
| Summarizing changes | Requires reading and condensing meaning |
| Answering questions about code | Requires reasoning about relationships |
| Writing commit messages from diffs | Requires understanding what changed and why |
| Refactoring suggestions | Requires understanding code structure and alternatives |
| Ambiguous input interpretation | When free-text arguments need contextual reasoning |
| Error diagnosis | When failure messages need contextual explanation |
| Multi-file cross-referencing | Understanding relationships across files beyond AST |
| Natural language output formatting | When users expect human-readable reports, not raw data |

## Patterns for Token-Efficient Extensions

### Pattern 1: Preprocess before prompting

Instead of asking the LLM to "find changed files and review them", find the files yourself and only send the relevant ones:

```typescript
// GOOD: Preprocess, then send focused prompt
const result = await pi.exec("git", ["diff", "--name-only", "HEAD"]);
const files = result.stdout.split("\n").filter(f => f.endsWith(".ts"));
const diffs = await Promise.all(
  files.map(f => pi.exec("git", ["diff", "HEAD", "--", f]).then(r => r.stdout))
);

pi.sendMessage({
  customType: "review",
  content: [{ type: "text", text: `Review these TypeScript changes:\n\n${diffs.join("\n---\n")}` }],
  display: "none",
}, { triggerTurn: true });
```

### Pattern 2: UI gates before LLM

Use UI to narrow scope before spending tokens:

```typescript
// GOOD: User selects scope via UI (free), then LLM reviews only that scope
const scope = await ctx.ui.select("Review scope", ["staged only", "all changes", "specific file"]);
if (scope === "specific file") {
  const files = (await pi.exec("git", ["diff", "--name-only"])).stdout.split("\n").filter(Boolean);
  const file = await ctx.ui.select("Which file?", files);
  if (!file) return;
  // Now review only ONE file instead of everything
}
```

### Pattern 3: Compute don't ask

If the answer can be computed, compute it:

```typescript
// BAD: Asking the LLM to count files
pi.sendUserMessage("How many TypeScript files are in this project?");

// GOOD: Compute it directly
const result = await pi.exec("git", ["ls-files", "--", "*.ts"]);
const count = result.stdout.split("\n").filter(Boolean).length;
ctx.ui.notify(`TypeScript files: ${count}`, "info");
```

### Pattern 4: TUI-only commands for configuration

Settings and toggles should never touch the LLM:

```typescript
// GOOD: Pure TUI settings menu
pi.on("input", (event, ctx) => {
  if (event.text.trim() === "/settings") {
    void showSettingsMenu(ctx); // all UI, zero tokens
    return { handled: true };
  }
});
```

### Pattern 5: Conditional LLM involvement

Only invoke the LLM when the situation requires it:

```typescript
// GOOD: Check if review is actually needed
const result = await pi.exec("git", ["diff", "--stat"]);
if (!result.stdout.trim()) {
  ctx.ui.notify("No changes to review", "info");
  return; // saved an entire LLM turn
}

// Changes exist — now involve the LLM
pi.sendMessage({ /* review prompt */ }, { triggerTurn: true });
```

### Pattern 6: System prompt injection over repeated instructions

Instead of including instructions in every user message, use event-based system prompt injection:

```typescript
// GOOD: Inject once via system prompt (infrastructure-level)
pi.on("before_agent_start", async () => {
  if (reviewMode) {
    return { systemPromptAppend: "You are in review mode. Only analyze, do not modify." };
  }
});

// BAD: Including instructions in every sendUserMessage call
pi.sendUserMessage("Remember you are in review mode. Only analyze, do not modify. Now review: ...");
```

### Pattern 7: `sendMessage` over `sendUserMessage`

When triggering the LLM programmatically, prefer `pi.sendMessage()` over `pi.sendUserMessage()`:

```typescript
// GOOD: sendMessage with customType — can be filtered from context on later turns
pi.sendMessage(
  { customType: "review", content: [{ type: "text", text: prompt }], display: "none" },
  { triggerTurn: true },
);

// LESS EFFICIENT: sendUserMessage — creates a permanent user message in context
pi.sendUserMessage(prompt);
```

`sendMessage` with `display: "none"` keeps the message invisible to the user but visible to the LLM. Its `customType` can be filtered via the `context` event on subsequent turns, saving tokens across the session. `sendUserMessage` creates a permanent user message that persists in context and cannot be easily filtered.

**Use `sendUserMessage` only when** the message should appear as a genuine user message in the conversation (e.g., injecting user-provided text).

### Pattern 8: Retroactive context filtering

Use the `context` event to strip old programmatic messages from context before they're sent to the LLM, keeping only recent ones:

```typescript
pi.on("context", async (event) => {
  // Keep only the last 5 review results in context — older ones waste tokens
  let reviewCount = 0;
  const filtered = event.messages.filter(msg => {
    if (msg.role === "custom" && msg.customType === "review-result") {
      reviewCount++;
      return reviewCount <= 5;
    }
    return true;
  });
  return { messages: filtered };
});
```

## When to Break the Rules

Token efficiency is a guideline, not a law. There are valid cases where involving the LLM is the right call even though TypeScript *could* handle it:

- **User-facing prose** (changelogs, summaries, PR descriptions) — you could template these, but the quality drop is significant
- **Error recovery** — when an extension hits unexpected state, letting the LLM reason about it often beats a generic error message
- **Adaptive behavior** — when the right approach depends on project structure the extension hasn't seen before
- **The naive markdown approach** has genuine advantages too: it is resilient to API changes, handles edge cases your TypeScript code hard-codes around, and adapts to project structure automatically. The tradeoff is cost vs. adaptability.

The goal is not to avoid the LLM — it's to use it *surgically*. If a task genuinely benefits from natural language understanding, spend the tokens.

## Anti-Patterns to Avoid

### Anti-Pattern 1: LLM as a data fetcher
```typescript
// BAD: Asking the LLM to get data you can get directly
pi.sendUserMessage("What branch am I on? What files have changed?");

// GOOD: Get the data yourself, only ask LLM to analyze it
const branch = (await pi.exec("git", ["branch", "--show-current"])).stdout.trim();
const changes = (await pi.exec("git", ["diff", "--stat"])).stdout;
// Now only send what needs analysis
```

### Anti-Pattern 2: LLM for yes/no decisions
```typescript
// BAD: Using LLM tokens for a simple confirmation
pi.sendUserMessage("Should I deploy to production? Please confirm.");

// GOOD: Use UI primitives
const ok = await ctx.ui.confirm("Deploy to production?", "This affects all users");
```

### Anti-Pattern 3: LLM for configuration
```typescript
// BAD: Asking LLM to change settings
pi.sendUserMessage("Change the model to claude-sonnet-4");

// GOOD: Do it directly
pi.setModel("claude-sonnet-4-20250514");
ctx.ui.notify("Model changed to claude-sonnet-4", "info");
```

### Anti-Pattern 4: Markdown commands for complex workflows
```markdown
<!-- BAD: .omp/commands/review.md — sends everything to LLM blind -->
Review the code changes in the current branch.
Look at all files, run the tests, and give me a report.
$ARGUMENTS
```

Every invocation of this sends a blind prompt. A TypeScript command that first checks what changed, runs tests itself, and then asks the LLM to analyze only the failures would be far more efficient.

### Anti-Pattern 5: Tool calls for deterministic operations
```typescript
// BAD: Registering an LLM-callable tool for something deterministic
pi.registerTool({
  name: "get_git_status",
  description: "Get the current git status",
  // This costs tokens every time the LLM calls it
});

// GOOD: Just run the command in your extension logic
const status = await pi.exec("git", ["status", "--short"]);
```

Register as an LLM tool if the LLM needs to decide WHEN to call it during its reasoning, or if the LLM needs to *compose* it with other tools in a multi-step plan (e.g., a `get_test_results` tool is deterministic but useful when the LLM is orchestrating a review workflow).

---

## Real-World Comparison

**Naive approach — all LLM, ~2000+ tokens per invocation:**
```markdown
<!-- .omp/commands/review.md -->
Please review the code in this project. First, find what files have changed.
Then read each changed file. Check for bugs, security issues, and style problems.
Run the tests if you can. Give me a summary.
$ARGUMENTS
```

**Token-efficient approach — ~500 tokens per invocation:**
```typescript
pi.registerCommand("review", {
  async handler(args, ctx) {
    // FREE: UI to pick scope
    const profile = await ctx.ui.select("Depth", ["quick", "thorough"]);
    if (!profile) return;

    // FREE: Get changed files
    const files = (await pi.exec("git", ["diff", "--name-only", "HEAD"])).stdout
      .split("\n").filter(Boolean);

    if (files.length === 0) {
      ctx.ui.notify("Nothing to review", "info");
      return; // Saved an entire LLM turn
    }

    // FREE: Run tests
    const testResult = await pi.exec("npm", ["test", "--", "--reporter=json"]);
    const testsPassed = testResult.code === 0;

    // MINIMAL TOKENS: Send only what the LLM needs
    const prompt = [
      `Review these ${files.length} files at ${profile} depth:`,
      files.map(f => `- ${f}`).join("\n"),
      testsPassed ? "All tests pass." : `Tests failed:\n${testResult.stderr.slice(0, 500)}`,
    ].join("\n\n");

    pi.sendMessage(
      { customType: "review", content: [{ type: "text", text: prompt }], display: "none" },
      { triggerTurn: true },
    );
  },
});
```

The TypeScript version does 80% of the work for free and sends a focused 500-token prompt instead of a vague 2000+ token one that also requires the LLM to do tool calls (each costing more tokens).
