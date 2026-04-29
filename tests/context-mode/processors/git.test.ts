import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_INVARIANT, gitProcessor } from "../../../src/context-mode/processors/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "git");
const encoder = new TextEncoder();

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

function process(text: string) {
  return gitProcessor(text, { exitCode: 0, eol: text.includes("\r\n") ? "\r\n" : "\n" });
}

describe("gitProcessor invariants", () => {
  test("status output preserves branch line and per-path status codes", () => {
    const output = process(fixture("status-large-posix.txt"));

    expect(output.processorKey).toBe("git");
    expect(output.passthrough).toBe(false);
    expect(output.text).toContain("## feature/l2-processors...origin/feature/l2-processors [ahead 2, behind 1]");
    expect(output.text).toContain(" M src/context-mode/hooks.ts");
    expect(output.text).toContain("A  src/context-mode/processors/git.ts");
    expect(output.text).toContain("R  src/context-mode/old-router.ts -> src/context-mode/new-router.ts");
    expect(output.text).toContain("?? tests/context-mode/processors/git.test.ts");
    expect(encoder.encode(output.text).byteLength).toBeLessThanOrEqual(GIT_INVARIANT.maxBytes);
  });

  test("diff output preserves hunk, rename, and net plus/minus counts", () => {
    const output = process(fixture("diff-large-posix.txt"));

    expect(output.processorKey).toBe("git");
    expect(output.text).toContain("diff --git a/src/context-mode/hooks.ts b/src/context-mode/hooks.ts");
    expect(output.text).toContain("@@ -10,7 +10,10 @@ import { routeToolCall } from \"./routing.js\";");
    expect(output.text).toContain("rename from src/context-mode/old-router.ts");
    expect(output.text).toContain("rename to src/context-mode/new-router.ts");
    expect(output.text).toContain("Net changes: +8 -3");
    expect(encoder.encode(output.text).byteLength).toBeLessThanOrEqual(GIT_INVARIANT.maxBytes);
  });

  test("log output preserves seven-character hashes and last five commit tail", () => {
    const output = process(fixture("log-large-posix.txt"));

    expect(output.processorKey).toBe("git");
    expect(output.text).toContain("a1b2c3d");
    for (const hash of ["f6a7b8c", "g7h8i9j", "h8i9j0k", "i9j0k1l", "j0k1l2m"]) {
      expect(output.text).toContain(hash);
    }
    expect(encoder.encode(output.text).byteLength).toBeLessThanOrEqual(GIT_INVARIANT.maxBytes);
  });

  test("identical input produces byte-identical output", () => {
    const input = fixture("diff-large-crlf.txt");
    const first = process(input);
    const second = process(input);

    expect(first.text).toBe(second.text);
    expect(first.text).toContain("\r\n");
  });

  test("non-zero exit code passes original text through", () => {
    const input = fixture("status-large-posix.txt");
    const output = gitProcessor(input, { exitCode: 1, eol: "\n" });

    expect(output).toEqual({
      text: input,
      processorKey: "git",
      passthrough: true,
    });
  });
});
