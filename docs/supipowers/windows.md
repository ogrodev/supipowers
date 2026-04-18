# Windows compatibility notes

## Built-in QA and Fix-PR flows are now shell-neutral

`/supi:qa` and `/supi:fix-pr` no longer steer the agent toward `.sh` scripts.
They now use portable Bun/TypeScript runners, so the built-in flow works from the default Windows shell environment instead of requiring Git Bash.

What this means in practice:
- `/supi:qa` starts/stops the dev server and runs generated Playwright tests through Bun entrypoints
- `/supi:fix-pr` triggers follow-up review and waits for new comments through Bun entrypoints
- the remaining external prerequisites are still real: Bun must be installed, `gh` must be available for PR automation, and `playwright-cli` must be available for the QA flow

## CI validation

This repository now validates `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`, and `bun test tests/` on:
- Ubuntu
- macOS
- Windows

That matrix exists to keep built-in flows honest across all supported operating systems.

## Remaining shell-specific boundary: custom release channels

Custom release channels are now executed through the OS-native shell automatically:
- Windows: `cmd /d /s /c`
- macOS/Linux: `sh -lc`

This makes the executor itself portable, but it does **not** make arbitrary user-authored command strings universally portable.

Examples:
- a Windows custom channel command should use `cmd` syntax
- a macOS/Linux custom channel command should use POSIX shell syntax

Built-in Supipowers commands are cross-platform; user-supplied release-channel commands remain the user's shell contract.
