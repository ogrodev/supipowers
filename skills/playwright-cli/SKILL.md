---
name: playwright-cli
description: Automates browser interactions for workflow QA validation with playwright-cli. Use when running manual-style E2E checks, collecting screenshots, and validating user flows.
allowed-tools: Bash(playwright-cli:* npx playwright-cli:*)
---

# Playwright CLI QA Skill

Use this skill to validate web workflows with `playwright-cli` and collect QA evidence.

## Default workflow

1. Confirm target URL and workflow under test.
2. Open browser session.
3. Navigate and execute workflow actions.
4. Capture screenshots at key checkpoints and failures.
5. Close session and summarize findings with pass/fail verdict.

## Quick commands

```bash
# start
playwright-cli open https://example.com

# navigation / interaction
playwright-cli goto https://example.com/checkout
playwright-cli click e12
playwright-cli fill e7 "user@example.com"
playwright-cli press Enter

# evidence
playwright-cli snapshot
playwright-cli screenshot --filename=.pi/supipowers/qa-runs/<run-id>/screenshots/checkpoint.png

# debug
playwright-cli console
playwright-cli network

# finish
playwright-cli close
```

## Session/auth reuse

If global `playwright-cli` is unavailable, fallback to:

```bash
npx playwright-cli open https://example.com
```

For QA runs, prefer repo-local evidence storage under:

```text
.pi/supipowers/qa-runs/
```

Keep auth/session artifacts local and gitignored.

## Validation checklist

- Reproducible workflow steps defined
- Screenshots captured for each test case
- Failures include concrete command/output context
- Final recommendation clearly states APPROVE or REFUSE
