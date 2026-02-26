# Troubleshooting

## `/sp-execute` says phase is invalid
You must reach `plan_ready` first:
1. `/sp-start`
2. `/sp-approve`
3. `/sp-plan`
4. `/sp-execute`

## Quality gates are blocking
Use `sp_revalidate` to inspect blockers and recommendations.
Typical blockers:
- missing test evidence
- missing run summary
- missing review-pass checkpoint (for `pre_finish` in stricter modes)

## Workflow stuck in `executing` after interruption
Supipowers auto-recovers stale `executing` state to `blocked` on next session start.
Then either:
- `/sp-execute` to retry, or
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

## How to reset everything
Use:
```text
/sp-reset --yes
```
