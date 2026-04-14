# Windows compatibility notes

## Git Bash requirement for AI-executed shell flows

`/supi:qa` and `/supi:fix-pr` still generate prompts that tell the AI to execute `.sh` scripts.
On Windows, those flows require a Unix-compatible shell such as Git Bash.

Why:
- the referenced scripts use Unix utilities like `grep`, `find`, `sed`, `wc`, and `nohup`
- those commands are not portable to plain `cmd.exe` or PowerShell
- if OMP's shell execution resolves to PowerShell or `cmd.exe`, the generated commands will fail

## Current recommendation

Use Git Bash as the shell environment when running these AI-steered flows on Windows.
That keeps the prompt-generated shell commands compatible without changing command behavior.

## Long-term direction

Replace prompt-level shell-script instructions with TypeScript-backed tools or other OMP-native actions so the AI can call portable interfaces instead of platform-specific shell commands.
