# Troubleshooting

## `/sp-execute` says phase is invalid
`/sp-execute` auto-prepares missing phases when possible.
If it still fails, the workflow is likely in a terminal/in-progress state (`executing`, `review_pending`, `ready_to_finish`).
Run:
1. `/sp-status`
2. `/sp-finish ...` or `/sp-reset --yes`
3. `/sp-execute` again

## `/sp-start` only updates status/header
`/sp-start` requires an objective. Use inline:
```text
/sp-start Implement login flow with tests
```

If you run `/sp-start` with no args, Supipowers prompts for the objective first. If there is a previous objective, press Enter to reuse it.
After objective capture, Supipowers auto-generates a plan and prompts for immediate execution.

## View toggle shortcut does not work on macOS terminal
Some terminals do not send `Option`/`Alt` combinations unless meta mode is enabled.

Try:
- `F6`
- `Alt+V`
- command fallback:
```text
/sp-view compact
/sp-view full
/sp-view status
```

## Quality gates are blocking
Use `sp_revalidate` to inspect blockers and recommendations.
Typical blockers:
- missing test evidence
- missing run summary
- missing review-pass checkpoint (for `pre_finish` in stricter modes)

## Workflow stuck in `executing` after interruption
Supipowers auto-recovers stale `executing` state to `blocked` on next session start.
Then either:
- `/sp-execute` to retry,
- `/sp-rewind` to pick a previous phase and redo,
- `/sp-reset` to restart from idle.

## Adapter selection is not what I expected
Current router preference:
1. `ant_colony` (when available and complexity warrants)
2. `subagent`
3. native fallback

To verify fallback behavior, inspect `.pi/supipowers/events.jsonl` for:
- `adapter_selected`
- `adapter_fallback`

## How to stop a running execution
Use:
```text
/sp-stop
```

## Release command fails
If `/sp-release` fails:
1. Ensure setup was run (`/sp-release-setup`).
2. Check working tree cleanliness (`git status --short`).
3. Verify auth for push/release (`gh auth status`).
4. Retry with `--dry-run` first.

Example dry-run:
```text
/sp-release --dry-run
```

If auto-version is not what you want, override with:
```text
/sp-release --bump minor --dry-run
/sp-release 0.1.1 --dry-run
```

## `/sp-qa` fails to start playwright-cli
`/sp-qa` probes:
1. `playwright-cli`
2. `npx playwright-cli`

If both fail, install one of them and retry.

Example:
```bash
npm i -g playwright-cli
# or use local fallback via npx
```

## `/sp-qa` has no evidence or auth is not reused
- Ensure run artifacts are under `.pi/supipowers/qa-runs/<run-id>/`.
- Ensure auth profile exists at `.pi/supipowers/qa/auth/profile.json`.
- Verify `.pi/` is listed in `.gitignore`.

## How to reset everything
Use:
```text
/sp-reset --yes
```
