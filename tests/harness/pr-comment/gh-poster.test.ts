import { describe, expect, mock, test } from "bun:test";

import { postStickyComment } from "../../../src/harness/pr-comment/gh-poster.js";
import { renderMarker, STICKY_MARKER_PREFIX } from "../../../src/harness/pr-comment/status.js";
import type { Platform } from "../../../src/platform/types.js";

interface ExecCall {
  bin: string;
  args: string[];
  opts: unknown;
}

interface ExecRecording {
  calls: ExecCall[];
  responses: Array<Partial<Awaited<ReturnType<Platform["exec"]>>> | Error>;
}

function makeExec(responses: ExecRecording["responses"]) {
  const recording: ExecRecording = { calls: [], responses };
  const exec = mock(async (bin: string, args: string[], opts: unknown) => {
    recording.calls.push({ bin, args, opts });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`Unexpected exec call: ${bin} ${args.join(" ")}`);
    }
    if (response instanceof Error) throw response;
    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      code: response.code ?? 0,
    };
  });
  return { exec, recording };
}

function makePlatform(exec: ReturnType<typeof makeExec>["exec"]): Platform {
  return { exec } as unknown as Platform;
}

const BODY = `${renderMarker({
  status: "passed",
  strict: 92,
  lenient: 95,
  sessionId: "01HZ",
  generatedAt: "2026-05-11T00:00:00Z",
})}\n## Body content\n`;

const FAILED_BODY = `${renderMarker({
  status: "failed",
  strict: 64,
  lenient: 71,
  sessionId: "01HZ",
  generatedAt: "2026-05-11T00:00:00Z",
})}\n## Body content\n`;

describe("postStickyComment — auth + missing cli", () => {
  test("returns skipped:no-cli when exec throws ENOENT", async () => {
    const { exec } = makeExec([new Error("spawn gh ENOENT")]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 1,
      cwd: ".",
      body: BODY,
      mode: "every-push",
      currentStatus: "passed",
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no-cli" });
  });

  test("returns skipped:no-auth when `gh auth status` exits non-zero", async () => {
    const { exec } = makeExec([{ code: 1, stderr: "not logged in" }]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 1,
      cwd: ".",
      body: BODY,
      mode: "every-push",
      currentStatus: "passed",
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no-auth" });
  });
});

describe("postStickyComment — create (no existing comment)", () => {
  test("issues POST when no sticky comment is found", async () => {
    const { exec, recording } = makeExec([
      { code: 0 }, // auth status
      { code: 0, stdout: "" }, // list comments (empty)
      { code: 0, stdout: '{"id": 555}' }, // POST
    ]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 42,
      cwd: "/work",
      body: BODY,
      mode: "every-push",
      currentStatus: "passed",
    });
    expect(outcome).toEqual({ kind: "created", commentId: 555 });
    const post = recording.calls[2];
    expect(post.bin).toBe("gh");
    expect(post.args).toContain("-X");
    expect(post.args).toContain("POST");
    expect(post.args).toContain("repos/octo/cat/issues/42/comments");
    expect(post.args).toContain("-f");
    expect(post.args).toContain(`body=${BODY}`);
  });

  test("returns failed when POST exits non-zero", async () => {
    const { exec } = makeExec([
      { code: 0 },
      { code: 0, stdout: "" },
      { code: 1, stderr: "validation failed" },
    ]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 1,
      cwd: ".",
      body: BODY,
      mode: "every-push",
      currentStatus: "passed",
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toContain("validation failed");
  });
});

describe("postStickyComment — update (existing comment)", () => {
  test("issues PATCH against the existing comment id", async () => {
    const previousBody = `${renderMarker({
      status: "warned",
      strict: 70,
      lenient: 88,
      sessionId: "01OLD",
      generatedAt: "2026-04-01T00:00:00Z",
    })}\n## old`;
    const listing = JSON.stringify({ id: 1234, body: previousBody });
    const { exec, recording } = makeExec([
      { code: 0 },
      { code: 0, stdout: listing },
      { code: 0, stdout: '{"id": 1234}' },
    ]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 7,
      cwd: ".",
      body: BODY,
      mode: "every-push",
      currentStatus: "passed",
    });
    expect(outcome).toEqual({ kind: "updated", commentId: 1234 });
    const patch = recording.calls[2];
    expect(patch.args).toContain("PATCH");
    expect(patch.args).toContain("repos/octo/cat/issues/comments/1234");
  });

  test("skips non-harness comments when scanning the list", async () => {
    const others = [
      JSON.stringify({ id: 1, body: "lgtm" }),
      JSON.stringify({ id: 2, body: "<!-- some-other-bot:v1 -->" }),
      JSON.stringify({ id: 99, body: `${STICKY_MARKER_PREFIX}status=passed strict=10 lenient=10 session=x generatedAt=y -->\n##` }),
    ].join("\n");
    const { exec, recording } = makeExec([
      { code: 0 },
      { code: 0, stdout: others },
      { code: 0, stdout: '{"id": 99}' },
    ]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 7,
      cwd: ".",
      body: BODY,
      mode: "every-push",
      currentStatus: "passed",
    });
    expect(outcome).toEqual({ kind: "updated", commentId: 99 });
    const patch = recording.calls[2];
    expect(patch.args).toContain("repos/octo/cat/issues/comments/99");
  });
});

describe("postStickyComment — on-status-change mode", () => {
  test("returns unchanged when previous and current statuses match", async () => {
    const sameStatusBody = `${renderMarker({
      status: "passed",
      strict: 90,
      lenient: 95,
      sessionId: "01OLD",
      generatedAt: "2026-04-01T00:00:00Z",
    })}\n## old`;
    const listing = JSON.stringify({ id: 1234, body: sameStatusBody });
    const { exec, recording } = makeExec([
      { code: 0 },
      { code: 0, stdout: listing },
    ]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 7,
      cwd: ".",
      body: BODY,
      mode: "on-status-change",
      currentStatus: "passed",
    });
    expect(outcome).toEqual({
      kind: "unchanged",
      commentId: 1234,
      reason: "status-unchanged",
    });
    // No PATCH was issued.
    expect(recording.calls.length).toBe(2);
  });

  test("PATCHes when the status flipped", async () => {
    const wasPassed = `${renderMarker({
      status: "passed",
      strict: 95,
      lenient: 98,
      sessionId: "01OLD",
      generatedAt: "2026-04-01T00:00:00Z",
    })}\n## old`;
    const listing = JSON.stringify({ id: 1234, body: wasPassed });
    const { exec } = makeExec([
      { code: 0 },
      { code: 0, stdout: listing },
      { code: 0, stdout: '{"id": 1234}' },
    ]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 7,
      cwd: ".",
      body: FAILED_BODY,
      mode: "on-status-change",
      currentStatus: "failed",
    });
    expect(outcome).toEqual({ kind: "updated", commentId: 1234 });
  });
});

describe("postStickyComment — listing failures", () => {
  test("returns failed when the listing call exits non-zero", async () => {
    const { exec } = makeExec([
      { code: 0 },
      { code: 1, stderr: "network is sad" },
    ]);
    const outcome = await postStickyComment(makePlatform(exec), {
      repo: "octo/cat",
      prNumber: 7,
      cwd: ".",
      body: BODY,
      mode: "every-push",
      currentStatus: "passed",
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toContain("network is sad");
  });
});
