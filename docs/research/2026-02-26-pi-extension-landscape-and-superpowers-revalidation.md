# Supipowers Research & Revalidation

**Date:** 2026-02-26  
**Project:** `supipowers`  
**Purpose:** Capture all findings, ideas, and strategic decisions from the initial research pass so they are reusable for architecture, implementation, and product decisions.

---

## 1) Objective

Build a **Pi-native** version of Superpowers that preserves the core promise:

> A practical framework that helps agents build things that actually work.

The extension should become a top-installed Pi tool by combining:
- Superpowers workflow discipline
- Pi runtime abilities (events, tools, TUI, commands, persistence)
- Optional integration with `oh-pi` (without hard dependency)

---

## 2) Sources Analyzed

### Primary repositories
- `https://github.com/obra/superpowers`
- `https://github.com/telagod/oh-pi`
- `https://github.com/nicobailon/pi-subagents`
- `https://github.com/ayagmar/pi-extmgr`
- `https://github.com/Graffioh/pi-screenshots-picker`

### Pi documentation consulted
- `docs/extensions.md`
- `docs/skills.md`
- `docs/packages.md`

### Key files reviewed (representative)
- Superpowers: `README.md`, `RELEASE-NOTES.md`, skills (`using-superpowers`, `brainstorming`, `writing-plans`, `subagent-driven-development`, `executing-plans`, `test-driven-development`, `systematic-debugging`, etc.), hooks, plugin manifests
- oh-pi: `README.md`, ant-colony extension (`pi-package/extensions/ant-colony/index.ts`), package manifest
- pi-subagents: `README.md`, `index.ts`, package manifest
- pi-extmgr: `README.md`, package manifest
- pi-screenshots-picker: `README.md`, package manifest

---

## 3) Snapshot Metrics (2026-02-26)

> Informational snapshot from public APIs at research time.

| Project | GitHub Stars | Weekly npm downloads |
|---|---:|---:|
| superpowers | 62,014 | 62 |
| oh-pi | 23 | 1,583 |
| pi-subagents | 304 | 1,857 |
| pi-extmgr | 11 | 549 |
| pi-screenshots-picker | 9 | 87 |

**Interpretation:**
- `superpowers` is conceptually huge and broadly recognized.
- In the Pi ecosystem specifically, practical utility extensions (`pi-subagents`, `oh-pi`, `pi-extmgr`) are currently leading adoption.

---

## 4) Revalidated Superpowers Core

Superpowers is not just a skills folder; it is a **workflow contract**:
1. Brainstorm before implementation
2. Validate/approve design
3. Write concrete implementation plan
4. Execute with structure and reviews
5. Enforce TDD discipline
6. Finish branch cleanly

### What must be preserved
- Process-first engineering
- Explicit checkpoints
- Evidence over claims
- Quality gates between phases

### What can be improved in Pi
- Move from instruction-only enforcement to runtime enforcement where appropriate
- Use Pi-native commands/tools/widgets/events for reliability and usability

---

## 5) What Successful Pi Extensions Do Well

### A) Fast activation and low friction
- `pi install npm:<pkg>`
- clear slash command entry points
- immediate first-use payoff

### B) Strong terminal UX
- TUI overlays, progress widgets, status bars, keyboard shortcuts
- clear state and progress feedback

### C) Operational reliability
- safe writes, staged operations, async status, resumability
- robust behavior in interactive + non-interactive modes

### D) Optional composability
- capabilities are modular
- dependency on other extensions is optional, not mandatory

---

## 6) Repo-by-Repo Strategic Takeaways

## 6.1 `superpowers`

**Strengths to keep:**
- Clear workflow philosophy
- Strong skill definitions for planning, TDD, debugging, review
- Multi-platform awareness and rapid compatibility iteration

**Gaps/opportunities for Pi adaptation:**
- Current approach is mostly prompt/skill behavior shaping
- Pi can add runtime state and hard/soft gates at event/tool level

## 6.2 `oh-pi`

**Strengths to learn from:**
- Excellent onboarding + perceived “supercharge” value
- Ant-colony gives compelling autonomous parallel execution
- Great progress signaling and interaction model

**Integration insight:**
- Treat ant colony as an optional execution backend
- If unavailable, provide equivalent fallback path

## 6.3 `pi-subagents`

**Strengths to learn from:**
- Rich subagent orchestration (`/run`, `/chain`, `/parallel`)
- Chain semantics, parallel flow, manager UI
- Strong support for skill injection and async observability

**Integration insight:**
- Natural fallback backend when `oh-pi` ant colony is absent

## 6.4 `pi-extmgr`

**Strengths to learn from:**
- Lifecycle management UX for extensions/packages
- safe staged changes, operational history, auto-update handling

**Integration insight:**
- Supipowers should be packaging- and update-friendly from day 1

## 6.5 `pi-screenshots-picker`

**Strengths to learn from:**
- Laser-focused workflow utility
- polish in keyboard UX and attachment flow

**Integration insight:**
- Keep supipowers flows ergonomic and minimal in user interaction overhead

---

## 7) Pi-Native Supipowers Positioning

## 7.1 Product thesis

Supipowers should be:
- **A workflow operating system** for software tasks in Pi
- Not only “more prompts”; instead a process runtime
- Opinionated but configurable

## 7.2 Core differentiation

From:
- “Agent should follow these instructions”

To:
- “Agent gets instructions + runtime support + checkpoints + observability.”

---

## 8) Optional `oh-pi` Integration Strategy (with Fallback)

Use capability detection and adapter routing.

| Capability | If `oh-pi` present | If absent |
|---|---|---|
| Complex autonomous execution | route to `ant_colony` | route to `subagent` chain/parallel, else sequential executor |
| Background progress snapshots | `bg_colony_status` + colony signals | native supipowers status + async logs |
| safety enhancements | leverage existing guards | use built-in supipowers safeguards |

**Rule:** No core feature should require `oh-pi` to function.

---

## 9) Supipowers Capability Buckets (End-State Vision)

1. Workflow state machine (phase-aware)
2. Design and planning orchestration
3. Execution orchestration adapters (colony/subagent/native)
4. TDD and debugging guardrails
5. Review gates (spec + quality)
6. Finish/merge/branch closure flows
7. TUI command and status UX
8. Observability and run history
9. Packaging and ecosystem compatibility

---

## 10) Risks Identified Early

1. **Over-enforcement risk**
   - If too rigid, users disable or avoid extension.
2. **Integration fragility**
   - External extension contracts may evolve.
3. **Feature bloat**
   - Must prioritize reliable core over novelty.
4. **Performance/cost drift**
   - Autonomous backends need clear limits and feedback.

---

## 11) Initial Design Principles

1. **Framework first** (always keep the “actually works” promise)
2. **Optional dependencies only**
3. **Graceful degradation**
4. **Transparent state and progress**
5. **Strict core, configurable strictness**
6. **Evidence-driven completion**

---

## 12) Decisions Captured from this Research Pass

- Build Supipowers as a Pi-first extension package.
- Keep Superpowers workflow DNA intact.
- Add runtime orchestration and safeguards using Pi extension APIs.
- Integrate with `oh-pi` and `pi-subagents` opportunistically via adapters.
- Ensure independent operation with no hard dependency on either.
- Implement observability and progress UX as first-class features.

---

## 13) Next Artifact

Implementation architecture and full-schema plan:  
`docs/plans/2026-02-26-supipowers-master-architecture-and-implementation-plan.md`
