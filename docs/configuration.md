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

## View modes
Supipowers has two runtime UI modes:
- `compact` (default): one-line footer status (`phase`, `objective`, `blocker` lock state)
- `full`: footer status + full widget lines

Toggle at runtime with:
- `F6` (recommended)
- `Alt+V`

Or use command fallback:
- `/sp-view compact`
- `/sp-view full`
- `/sp-view status`

View mode is persisted per repository in `.pi/supipowers/view-mode.json`.

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

## Release pipeline configuration

`/sp-release` reads:

```text
.pi/supipowers/release.pipeline.json
```

Generate it with:

```text
/sp-release-setup
```

You can customize commands for any stack/repo. Placeholders supported in command args:
- `{version}`
- `{tag}`

Minimal structure:

```json
{
  "preset": "generic",
  "tagFormat": "v{version}",
  "filesToStage": ["CHANGELOG.md"],
  "validate": [],
  "versionBump": { "command": "echo", "args": ["set version {version}"] },
  "commit": { "command": "git", "args": ["commit", "-m", "chore(release): {tag}"] },
  "tag": { "command": "git", "args": ["tag", "{tag}"] },
  "push": [
    { "command": "git", "args": ["push", "origin", "main"] },
    { "command": "git", "args": ["push", "origin", "{tag}"] }
  ],
  "release": { "command": "gh", "args": ["release", "create", "{tag}", "--title", "{tag}"] }
}
```
