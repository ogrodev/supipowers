# Shell Commands

## Shell Commands

```typescript
// shell-utils.ts
import { exec, execFile } from "child_process";
import { readdir } from "fs/promises";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class ShellUtils {
  // WARNING: Runs `command` through a shell. NEVER pass untrusted input here —
  // shell metacharacters (`$()`, backticks, `;`, `|`, `&`, redirections) will
  // be interpreted. For any value derived from user input, prefer
  // `executeSafe` below, which uses execFile and does not invoke a shell.
  static async execute(command: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        shell: this.getShell(),
      });
      if (stderr) console.error(stderr);
      return stdout.trim();
    } catch (error) {
      throw new Error(`Command failed: ${(error as Error).message}`);
    }
  }

  // Safe execution with argv array — no shell interpretation. Use this for
  // any path or value that may originate outside the program.
  static async executeSafe(command: string, args: string[] = []): Promise<string> {
    const { stdout, stderr } = await execFileAsync(command, args);
    if (stderr) console.error(stderr);
    return stdout.trim();
  }
  // Get platform-specific shell
  static getShell(): string {
    if (process.platform === "win32") {
      return "cmd.exe";
    }
    return process.env.SHELL || "/bin/sh";
  }

  // Prefer runtime APIs for filesystem work. Shell builtins like `dir` must
  // go through cmd.exe, where caller-supplied paths are shell-parsed unless
  // explicitly escaped.
  static async listFiles(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map((entry) => entry.name).join("\n");
  }

  static async clearScreen(): Promise<void> {
    process.stdout.write("\x1Bc");
  }

  static async openFile(filepath: string): Promise<void> {
    if (process.platform === "win32") {
      await execFileAsync("explorer.exe", [filepath]);
    } else if (process.platform === "darwin") {
      await execFileAsync("open", [filepath]);
    } else {
      await execFileAsync("xdg-open", [filepath]);
    }
  }
}
```
