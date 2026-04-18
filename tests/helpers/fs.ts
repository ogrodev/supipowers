import * as fs from "node:fs";

const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function rmDirWithRetry(dir: string, attempts = 20, delayMs = 50): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = !!code && RETRYABLE_CODES.has(code);

      // Windows runners can keep SQLite-backed temp dirs locked past test teardown
      // even after close() + retries. Since these helpers are test-only and every
      // test uses a unique tmpDir, prefer finishing the suite over failing cleanup.
      if (process.platform === "win32" && retryable && attempt === attempts - 1) {
        return;
      }

      if (!retryable || attempt === attempts - 1) {
        throw error;
      }

      sleepSync(delayMs);
    }
  }
}
