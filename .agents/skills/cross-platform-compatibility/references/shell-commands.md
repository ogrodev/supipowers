# Shell Commands

## Shell Commands

```typescript
// shell-utils.ts
import { exec, execFile } from "child_process";
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

  // Platform-specific commands — all use execFile so caller-supplied paths
  // are passed as discrete argv entries and never interpolated into a shell.
  static async listFiles(directory: string): Promise<string> {
    if (process.platform === "win32") {
      // `dir` is a cmd.exe builtin; invoke it through `cmd /c` but keep the
      // directory argument out of the shell-parsed command string.
      const { stdout } = await execFileAsync("cmd", ["/c", "dir", directory]);
      return stdout.trim();
    }
    const { stdout } = await execFileAsync("ls", ["-la", directory]);
    return stdout.trim();
  }

  static async clearScreen(): Promise<void> {
    if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "cls"]);
    } else {
      await execFileAsync("clear", []);
    }
  }

  static async openFile(filepath: string): Promise<void> {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the window title slot so
      // a quoted filepath isn't mistaken for the title.
      await execFileAsync("cmd", ["/c", "start", "", filepath]);
    } else if (process.platform === "darwin") {
      await execFileAsync("open", [filepath]);
    } else {
      await execFileAsync("xdg-open", [filepath]);
    }
  }
}
```
