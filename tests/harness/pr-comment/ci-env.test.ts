import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { detectCiContext } from "../../../src/harness/pr-comment/ci-env.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-ci-env-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvent(payload: unknown): string {
  const eventPath = path.join(tmpDir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(payload), "utf8");
  return eventPath;
}

describe("detectCiContext", () => {
  test("returns null when GITHUB_REPOSITORY is missing", () => {
    expect(detectCiContext({})).toBeNull();
  });

  test("returns null for a malformed repo string", () => {
    expect(detectCiContext({ GITHUB_REPOSITORY: "no-slash-here" })).toBeNull();
  });

  test("returns null when event file is unreadable", () => {
    const ctx = detectCiContext({
      GITHUB_REPOSITORY: "octo/cat",
      GITHUB_EVENT_PATH: path.join(tmpDir, "missing.json"),
    });
    expect(ctx).toBeNull();
  });

  test("returns null when event file is not a pull_request event", () => {
    const eventPath = writeEvent({ issue: { number: 5 } });
    const ctx = detectCiContext({
      GITHUB_REPOSITORY: "octo/cat",
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(ctx).toBeNull();
  });

  test("extracts pr number, base ref + sha, and run url from env + event JSON", () => {
    const eventPath = writeEvent({
      pull_request: {
        number: 142,
        base: { ref: "main", sha: "a1b2c3d4e5f6" },
      },
    });
    const ctx = detectCiContext({
      GITHUB_REPOSITORY: "octo/cat",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "9876",
    });
    expect(ctx).toEqual({
      repo: "octo/cat",
      prNumber: 142,
      runUrl: "https://github.com/octo/cat/actions/runs/9876",
      baseRef: "main@a1b2c3d",
    });
  });

  test("falls back to base.ref alone when sha is missing", () => {
    const eventPath = writeEvent({
      pull_request: {
        number: 7,
        base: { ref: "develop" },
      },
    });
    const ctx = detectCiContext({
      GITHUB_REPOSITORY: "octo/cat",
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(ctx?.baseRef).toBe("develop");
  });

  test("overrides win over env values", () => {
    const ctx = detectCiContext(
      { GITHUB_REPOSITORY: "wrong/repo" },
      { repo: "octo/cat", prNumber: 1 },
    );
    expect(ctx).toEqual({ repo: "octo/cat", prNumber: 1 });
  });

  test("rejects non-positive PR numbers", () => {
    const ctx = detectCiContext(
      { GITHUB_REPOSITORY: "octo/cat" },
      { prNumber: 0 },
    );
    expect(ctx).toBeNull();
  });
});
