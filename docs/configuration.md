# Supipowers Configuration

Create `.pi/supipowers/config.json` in your project:

```json
{
  "strictness": "balanced",
  "showWidget": true,
  "showStatus": true
}
```

## Options

### `strictness`
- `strict`: missing major/minor gates block progression.
- `balanced` (default): major gate failures block; minor issues warn.
- `advisory`: no blocking from policy checks, but warnings remain visible.

### `showWidget`
- `true`: show workflow widget lines in TUI.
- `false`: disable widget output.

### `showStatus`
- `true`: show status bar updates.
- `false`: disable status output.

## Finish command modes
`/sp-finish <mode>` supports:
- `merge`
- `pr`
- `keep` (default)
- `discard`

Optional flags:
- `--review-pass` or `--approve-review`

## Revalidation tool
Tool: `sp_revalidate`

Parameters:
- `scope`: `all` | `tdd` | `review` | `verification`
- `stage`: `manual` | `pre_execute` | `post_execute` | `pre_finish`
