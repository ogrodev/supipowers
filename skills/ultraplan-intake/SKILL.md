---
name: ultraplan-intake
description: Structured extraction of the user's seed prompt into a typed intake artifact — first stage of the UltraPlan authoring pipeline
---

# UltraPlan Intake

Extract a structured, complete intake artifact from the user's seed prompt. This is the first stage of the multi-stage authoring pipeline. It runs once per session.

## Quick Reference

| Aspect | Detail |
|--------|--------|
| **Input** | Raw user goal/prompt (provided by the pipeline runner as `seedPrompt`) |
| **Output** | Intake artifact written via `ultraplan_intake_record` |
| **Scope** | Extraction only — no library selection, no scenario generation, no clarifying questions |
| **Constraint** | Do NOT chat with the user. Do NOT pick libraries. Do NOT generate scenarios. |
| **Storage tool** | `ultraplan_intake_record` — called exactly once |

## What You Extract

From the seed prompt, populate each field below. If a field cannot be determined from the prompt, leave it as an explicit null or empty list — do not invent.

| Field | Type | Rule |
|-------|------|------|
| `title` | string | Short noun phrase (≤10 words) describing the feature or project |
| `goal` | string | One sentence capturing the user's stated outcome |
| `stackApplicability` | `{ frontend, backend, infrastructure }` | `applicable` if the prompt implies work in that stack; `not-applicable` if clearly excluded; `unknown` if ambiguous |
| `deferredIdeas` | string[] | Ideas mentioned in the prompt that are out of scope for this session — nice-to-haves, future features, speculative extensions |
| `constraints` | string[] | Explicit constraints stated by the user (performance targets, tech restrictions, team limits) |
| `successCriteria` | string[] | Measurable outcomes the user stated or clearly implied |

## Stack Applicability Rules

- `frontend`: prompt mentions UI, pages, components, browser, client, mobile, design, UX.
- `backend`: prompt mentions API, server, database, service, auth, worker, queue, jobs.
- `infrastructure`: prompt mentions hosting, CI/CD, deployment, containers, cloud, IaC, monitoring, secrets.
- Mark `unknown` when the prompt is ambiguous. The discover stage resolves `unknown` entries.
- Mark `not-applicable` only when the stack is explicitly excluded or clearly irrelevant.

## Process

### Step 1 — Read the seed prompt exactly as given

Do not paraphrase. Treat the user's words as ground truth.

### Step 2 — Extract each field

Work field by field in the order listed in the table above. Apply the stack applicability rules. Collect deferred ideas as-is: do not evaluate or prioritize them.

### Step 3 — Write the artifact

Call `ultraplan_intake_record` exactly once with the fully populated object:

```
ultraplan_intake_record({
  title: string,
  goal: string,
  stackApplicability: {
    frontend: "applicable" | "not-applicable" | "unknown",
    backend: "applicable" | "not-applicable" | "unknown",
    infrastructure: "applicable" | "not-applicable" | "unknown"
  },
  constraints: string[],
  successCriteria: string[],
  deferredIdeas: string[]
})
```

Do not call `ultraplan_intake_record` more than once.

## MUST DO / MUST NOT DO

| MUST DO | MUST NOT DO |
|---------|-------------|
| Extract only what the seed prompt states or clearly implies | Ask the user clarifying questions |
| Mark ambiguous stacks as `unknown` | Pick libraries, frameworks, or implementation approaches |
| Collect deferred ideas verbatim | Generate scenarios, domains, or tasks |
| Call `ultraplan_intake_record` exactly once | Call it zero times or more than once |
| Leave fields null/empty when undeterminable | Invent constraints or success criteria |

## Final Checklist

- [ ] `title` is ≤10 words and noun-phrase form
- [ ] `goal` is a single sentence
- [ ] All three stacks have an applicability value (not missing)
- [ ] `deferredIdeas` contains only ideas mentioned in the prompt, not invented ones
- [ ] `ultraplan_intake_record` called exactly once
- [ ] No clarifying questions sent to the user
