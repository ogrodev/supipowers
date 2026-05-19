# Process Management

## Process Management

```typescript
// process-utils.ts
import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";

// Use execFile rather than exec so arguments are passed as argv and never
// interpreted by a shell. This is the safe primitive for any value that
// may originate from user input.
const execFileAsync = promisify(execFile);

export class ProcessUtils {
  // Kill process by PID with platform-specific signal
  static kill(pid: number, signal?: string): void {
    if (process.platform === "win32") {
      // Windows doesn't support signals, use taskkill
      spawn("taskkill", ["/pid", pid.toString(), "/f", "/t"]);
    } else {
      process.kill(pid, signal || "SIGTERM");
    }
  }

  // Spawn process with platform-specific handling
  static spawnCommand(command: string, args: string[] = []): ChildProcess {
    if (process.platform === "win32") {
      // Windows requires cmd.exe to run commands
      return spawn("cmd", ["/c", command, ...args], {
        stdio: "inherit",
        shell: true,
      });
    }

    return spawn(command, args, {
      stdio: "inherit",
      shell: true,
    });
  }

  // Find process by name
  static async findProcess(name: string): Promise<number[]> {
    // Defense in depth: reject names with shell-meta or whitespace before
    // ever handing them to a subprocess.
    if (!/^[\w.\-]+$/.test(name)) {
      throw new Error(`Invalid process name: ${name}`);
    }

    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", [
        "/FI",
        `IMAGENAME eq ${name}`,
      ]);
      // Parse Windows tasklist output
      const pids: number[] = [];
      for (const line of stdout.split("\n")) {
        const match = line.match(/\s+(\d+)\s+/);
        if (match) pids.push(parseInt(match[1]));
      }
      return pids;
    }

    try {
      const { stdout } = await execFileAsync("pgrep", ["--", name]);
      return stdout.split("\n").filter(Boolean).map(Number);
    } catch (error) {
      // pgrep exits 1 when nothing matches; treat that as an empty result.
      if ((error as { code?: number }).code === 1) return [];
      throw error;
    }
  }
}
```
