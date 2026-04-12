# Release Polish Mode

Rewrite raw commit logs into user-facing release notes, then execute the release after confirmation.

## Quick Reference

| Aspect | Detail |
|---|---|
| **Trigger** | `/supi:release` command |
| **Input** | Markdown changelog with commit hashes + ordered list of shell commands to execute |
| **Output** | Polished changelog shown to user → confirmation → sequential command execution with status reporting |
| **Scope** | Rewrite language only — no version changes, no command changes, no invented content |

## Input Contract

You receive two things from `/supi:release`:

1. **Raw changelog** — Markdown with sections (some may be empty) and entries like:
   ```
   ### Features
   - feat(auth): add token refresh (a1b2c3d)
   - feat(auth): handle edge case in refresh (e4f5g6h)
   ```
2. **Release commands** — ordered shell commands to execute verbatim after confirmation:
   ```
   git tag v1.2.0
   git push origin v1.2.0
   npm publish
   ```

## Output Contract

1. Polished changelog (Markdown, same structure)
2. Confirmation prompt: `"Ready to release v{version}?"`
3. On approval: sequential command execution with per-command status
4. On failure: structured error report (see Error Handling)

## Rewriting Entries

Transform technical commit messages into user-facing language. Every entry MUST retain its hash(es) at the end: `(abc1234)`.

### Before / After

| Raw | Polished |
|---|---|
| `fix: handle null in parseConfig (a1b2c3d)` | `Fixed a crash when configuration values were missing (a1b2c3d)` |
| `feat(auth): add token refresh (e4f5g6h)` | `Added automatic token refresh to prevent session expiry (e4f5g6h)` |
| `refactor: extract parseConfig into util module (x9y8z7w)` | *(omit — internal restructuring with no user-visible effect)* |
| `X was fixed in the parser` | `Fixed X in the parser` *(prefer active voice)* |

## Grouping Related Changes

When multiple commits touch the same feature, consolidate into one entry. Keep the hash of the commit whose message best describes the user-visible change.

### Before

```markdown
### Features
- feat(auth): add token refresh endpoint (a1b2c3d)
- feat(auth): handle refresh token expiry edge case (e4f5g6h)
- feat(auth): add refresh token rotation (i7j8k9l)
```

### After

```markdown
### Features
- Added automatic token refresh with rotation and expiry handling (a1b2c3d)
```

## Section Order

Maintain these sections in this fixed order. Omit any section with no entries.

1. **Breaking Changes** — requires user action on upgrade
2. **Features** — new capabilities
3. **Fixes** — bugs resolved
4. **Improvements** — refactors, performance gains, reverts
5. **Maintenance** — chores, CI, build, tests, docs, style
6. **Other** — non-conventional commits

## MUST DO / MUST NOT DO

| MUST | MUST NOT |
|---|---|
| Retain original commit hash(es) on every entry | Change the version number |
| Omit empty sections entirely | Invent features or fixes not in the provided commits |
| Consolidate related commits into one entry | Modify or reorder the release commands |
| Use active voice ("Fixed X" not "X was fixed") | Skip the confirmation step |
| Omit internal-only commits (refactors, renames, extractions with no user-visible effect) | Reorder sections from the fixed order above |
| Always include scope when the changelog covers multiple packages/areas | Attempt cleanup or undo after a failed command |

## Confirmation Flow

After presenting the polished changelog:

1. Show the full formatted changelog
2. Ask: `"Ready to release v{version}?"`
3. **yes** → execute commands in sequence, reporting each:
   ```
   Running: git tag v1.2.0 ... ✓
   Running: git push origin v1.2.0 ... ✓
   Running: npm publish ... ✓
   Release v1.2.0 complete.
   ```
4. **no** → ask: `"Would you like to edit the changelog further, or abort entirely?"`
   - **edit**: accept corrections, re-present, re-confirm
   - **abort**: stop without executing any commands

## Error Handling

If any release command fails, stop immediately. Report in this format:

```
✗ Command failed: npm publish
  Error: ERR_403 You do not have permission to publish

Succeeded:
  ✓ git tag v1.2.0
  ✓ git push origin v1.2.0

Not run:
  - gh release create v1.2.0

Manual intervention required — do not attempt to undo.
```

## Final Checklist

Before yielding the polished changelog, verify:

- [ ] Every entry has at least one commit hash
- [ ] No empty sections remain
- [ ] Version number is unchanged from the original
- [ ] Release commands are unmodified
- [ ] No internal-only commits (pure refactors, renames) appear in the output
- [ ] Sections follow the fixed order
