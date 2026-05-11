# Harness PR comment

`/supi:harness pr-comment` renders a sticky PR comment from the most recent
`validate-report.json` and (optionally) posts it to the active pull request.

It is the GitHub-side surface of `/supi:harness validate`: the same data, projected into a
single comment that reviewers can scan in seconds. The comment is **sticky** — one per PR,
edited in place on every push — so the PR thread stays signal-dense.

## Status banner

The comment leads with one of three states:

| Banner | When |
|---|---|
| 🟢 `Harness · score X / Y strict` | Every check passed and the score floor is satisfied. |
| 🟡 `Harness · score X / Y strict` | Every check passed but the strict score is below the configured floor. |
| 🔴 `Harness · score X / Y strict · blocked` | At least one validate check failed. |

The banner also carries a signed strict-score delta vs the previous run when score history
is available.

## Triggering modes

`HarnessCiConfig.prComment` (in `design-spec.json`) drives behaviour:

```json
{
  "enabled": true,
  "mode": "every-push"
}
```

- `enabled` — when `false`, the subcommand is a no-op outside `--dry-run`. When the
  `prComment` block is absent altogether the subcommand still runs with built-in
  defaults; an explicit `enabled: false` is the only way to suppress posting.
- `mode`:
  - `every-push` (default) — update the sticky comment on every CI run.
  - `on-status-change` — only re-post when the status (`passed` / `warned` / `failed`)
    changes. Useful in chatty repos where rapid pushes would otherwise produce identical
    updates.

Posting is **always fail-open** at runtime: a missing `gh`, missing auth, or missing PR
context falls back to `$GITHUB_STEP_SUMMARY` and the command still exits 0.

The CLI accepts `--mode=every-push|on-status-change` as a one-off override.

## Sticky marker

The first line of the body is a stable HTML comment:

```
<!-- supipowers:harness:v1 status=<status> strict=<n> lenient=<n> session=<id> generatedAt=<iso> -->
```

The poster locates the existing sticky by this prefix and either PATCHes it or POSTs a new
one. `on-status-change` mode parses the previous `status=` field to decide whether to skip.

## Workflow snippet

The harness design stage records `ci.workflowPath`, but installing the workflow file is the
user's call. Use this snippet as the canonical template:

```yaml
name: harness
on:
  pull_request: {}
permissions:
  contents: read
  pull-requests: write
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run harness:quality
      - if: github.event_name == 'pull_request'
        run: bunx supipowers pr-comment
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The `permissions: pull-requests: write` block is **required** for the sticky upsert. The
`ci-local-wiring` validate check surfaces a warning when this is missing and
`prComment.enabled` is true — so the harness flags the gap before CI fails with a 403.

## Local preview

```sh
/supi:harness pr-comment --dry-run [--session=<id>]
```

Renders the body to stdout/UI. No `gh` call, no environment variables required. Use it to
iterate on the comment shape, or to inspect what CI is about to post.

You can also force a real post outside CI by supplying the missing context:

```sh
/supi:harness pr-comment --pr=42 --repo=octo/cat
```

This still goes through `gh auth status`; an unauthenticated `gh` falls back to the
workflow summary path (and exits 0).

## Fail-open guarantees

The handler **never throws**. Every failure mode resolves to a typed outcome and a
one-line notification:

- `created` / `updated` — comment was upserted.
- `unchanged` — `on-status-change` mode + status matched.
- `skipped: no-cli` / `no-auth` / `no-pr-env` — preconditions not met.
- `failed: …` — gh CLI rejected the request.

In the `skipped` / `failed` paths the body is written to `$GITHUB_STEP_SUMMARY` (when
available) so the data is never lost.

## What the comment includes

| Section | Content |
|---|---|
| Banner | emoji + score + delta + blocked flag |
| Summary | one sentence: checks pass/fail count, new slop count, score-floor status, base ref |
| Failed checks (auto-expanded) | per-check invariant + finding table; slop counts for `anti-slop-scan` |
| Passed checks (collapsed) | one-line list |
| Scorecard | duplicates / dead-code / layer-violations / other × {score, Δ, open, resolved, wontfix} |
| Trend | strict score across the last N runs (collapsed on green) |
| Footer | score floor · session · log link · `🤖 /supi:harness validate` |

Per-dimension Δ columns currently render `—` because score-history v1 only persists the
top-level scalars. The banner Δ is meaningful.
