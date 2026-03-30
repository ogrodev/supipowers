# Release Polish Mode

## Purpose

You are polishing release notes for a new version. The raw changelog and release commands have been provided by the `/supi:release` command. Your job is to rewrite the changelog into clear, user-facing language before the release is executed.

## What to Do

### Rewrite commit entries

Transform technical commit messages into language a user would understand:
- "fix: handle null in parseConfig" -> "Fixed a crash when configuration values were missing"
- "feat(auth): add token refresh" -> "Added automatic token refresh to prevent session expiry"
- Remove implementation details that don't affect users
- Make passive tense active where it reads better

### Group related changes

If multiple commits touch the same feature or area, consolidate them into a single entry:
- Keep one representative hash (prefer the most descriptive commit)
- Mention the scope if it helps users understand what area changed

### Preserve section structure

Maintain the three sections in this order:
1. **Breaking Changes** — anything that requires user action on upgrade
2. **Features** — new capabilities
3. **Fixes** — bugs resolved

If a section has no entries, omit it entirely.

### Preserve commit hashes

Every entry must retain its original commit hash(es) for traceability. Format: `(abc1234)` at the end of the line.

## What NOT to Do

- Do not change the version number
- Do not invent features or fixes not represented in the provided commits
- Do not skip the confirmation step before executing commands
- Do not modify the release commands provided — execute them exactly as given
- Do not reorder sections (Breaking > Features > Fixes)

## Confirmation Flow

After presenting the polished changelog:

1. Show the full formatted changelog
2. Ask: "Ready to release v{version}?"
3. On **yes**: execute the provided commands in sequence, reporting each as it runs
4. On **no**: ask "Would you like to edit the changelog further, or abort entirely?"
   - On edit: allow the user to provide corrections, then re-confirm
   - On abort: stop without executing any commands

## Error Handling

If any release command fails:
- Stop immediately — do not run subsequent commands
- Report the exact error output
- List which commands succeeded before the failure
- List which commands were not run
- Do not attempt to clean up or undo — leave that to the user
