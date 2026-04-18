import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths } from "../../src/platform/types.js";
import {
  cancelUiDesignTracking,
  registerUiDesignApprovalHook,
  startUiDesignTracking,
} from "../../src/ui-design/session.js";
import type { Manifest, UiDesignSession } from "../../src/ui-design/types.js";

let tmpDir: string;

const VALID_PAGE_HTML = "<!DOCTYPE html><html><body><main>page</main></body></html>";
const VALID_REVIEW_HTML = "<!DOCTYPE html><html><body><section>review</section></body></html>";
const VALID_DECOMPOSITION_HTML =
  "<!DOCTYPE html><html><body><section>decomposition</section></body></html>";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ui-design-integration-"));
  cancelUiDesignTracking("integration-setup");
});

afterEach(() => {
  cancelUiDesignTracking("integration-teardown");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkSession(dir: string): UiDesignSession {
  return {
    id: "uidesign-20260418-120000-abcd",
    dir,
    backend: "local-html",
    companionUrl: "http://localhost:4321",
  };
}

function writeManifest(dir: string, manifest: Manifest): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function writeCompletionArtifacts(
  dir: string,
  manifest: Manifest,
  overrides: {
    pageHtml?: string | null;
    critiqueMd?: string | null;
    reviewHtml?: string | null;
    contextMd?: string | null;
    decompositionHtml?: string | null;
    decompositionJson?: string | null;
    approvalRecord?:
      | {
          selected?: "approve" | "request-changes" | "discard";
          recordedAt?: string;
        }
      | null;
  } = {},
): void {
  if (overrides.contextMd !== null) {
    fs.writeFileSync(path.join(dir, "context.md"), overrides.contextMd ?? "# Context\n\n- integration\n");
  }
  if (overrides.decompositionHtml !== null) {
    fs.writeFileSync(
      path.join(dir, "screen-decomposition.html"),
      overrides.decompositionHtml ?? VALID_DECOMPOSITION_HTML,
    );
  }
  if (overrides.decompositionJson !== null) {
    fs.writeFileSync(
      path.join(dir, "decomposition.json"),
      overrides.decompositionJson ?? JSON.stringify({ components: manifest.components, sections: manifest.sections }, null, 2),
    );
  }
  if (overrides.pageHtml !== null) {
    fs.writeFileSync(path.join(dir, manifest.page), overrides.pageHtml ?? VALID_PAGE_HTML);
  }
  if (overrides.critiqueMd !== null) {
    fs.writeFileSync(
      path.join(dir, "critique.md"),
      overrides.critiqueMd ?? "# Critique\n\n## Fixable\n\n- none\n\n## Advisory\n\n- none\n",
    );
  }
  if (overrides.reviewHtml !== null) {
    fs.writeFileSync(path.join(dir, "screen-review.html"), overrides.reviewHtml ?? VALID_REVIEW_HTML);
  }
  if (overrides.approvalRecord !== null) {
    const approval = overrides.approvalRecord ?? {};
    fs.writeFileSync(
      path.join(dir, "review-approval.json"),
      JSON.stringify(
        {
          question: "Approve the mockup?",
          options: ["approve", "request-changes", "discard"],
          selected: approval.selected ?? "approve",
          selectedLabel: approval.selected ?? "approve",
          recordedAt: approval.recordedAt ?? "2026-04-18T00:05:00.000Z",
        },
        null,
        2,
      ),
    );
  }
}

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "uidesign-20260418-120000-abcd",
    backend: "local-html",
    status: "complete",
    acknowledged: false,
    createdAt: "2026-04-18T00:00:00.000Z",
    approvedAt: "2026-04-18T00:05:00.000Z",
    components: [],
    sections: [],
    page: "page.html",
    ...overrides,
  };
}

function registerHook(opts: {
  select: (title: string, options: string[]) => Promise<string | null>;
  sendMessage?: (...args: any[]) => void;
  exec?: (...args: any[]) => Promise<any>;
}) {
  let handler: ((event: any, ctx: any) => Promise<void>) | null = null;
  const platform: any = {
    on: (name: string, cb: any) => {
      if (name === "agent_end") handler = cb;
    },
    sendMessage: opts.sendMessage ?? mock(),
    exec: opts.exec ?? mock(async () => ({ code: 0, stdout: "", stderr: "" })),
    paths: createPaths(".omp"),
  };
  registerUiDesignApprovalHook(platform);
  const ctx = {
    hasUI: true,
    cwd: tmpDir,
    ui: {
      select: mock(opts.select),
      notify: mock(),
    },
  };
  return { platform, handler: handler!, ctx };
}

function extractSteerText(sendMessage: ReturnType<typeof mock>): string {
  const [message] = sendMessage.mock.calls[0] as [
    { content: Array<{ text: string }> },
    { deliverAs: string; triggerTurn: boolean },
  ];
  return message.content[0]?.text ?? "";
}

describe("ui-design integration flow — all 7 manifest branches", () => {
  test("[1] complete + acknowledged:false → Keep → acknowledge + cleanup", async () => {
    const sessionDir = path.join(tmpDir, "s1");
    const manifest = baseManifest();
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest);
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    const { handler, ctx } = registerHook({
      select: async () => "Keep artifacts and exit",
    });
    await handler({}, ctx);

    const rewritten = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf-8"));
    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(rewritten.acknowledged).toBe(true);
    expect(rewritten.critique).toEqual({ fixableCount: 0, advisoryCount: 0, fixIterations: 0 });
    expect(proof.valid).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("[2] complete without approval proof → resume/discard instead of success", async () => {
    const sessionDir = path.join(tmpDir, "s2");
    const manifest = baseManifest({ approvedAt: undefined });
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest, { approvalRecord: null });
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    let seenOptions: string[] | null = null;
    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHook({
      select: async (_title, options) => {
        seenOptions = options;
        return "Resume session";
      },
      sendMessage,
    });
    await handler({}, ctx);

    expect(seenOptions as string[] | null).toEqual(["Resume session", "Discard session"]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("[2b] complete with unresolved critique still offers resume/discard", async () => {
    const sessionDir = path.join(tmpDir, "s2b");
    const manifest = baseManifest();
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest, {
      critiqueMd: "# Critique\n\n## Fixable\n\n- increase spacing\n\n## Advisory\n\n- none\n",
    });
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    let seenOptions: string[] | null = null;
    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHook({
      select: async (_title, options) => {
        seenOptions = options;
        return "Resume session";
      },
      sendMessage,
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(seenOptions as string[] | null).toEqual(["Resume session", "Discard session"]);
    expect(proof.valid).toBe(false);
    expect(proof.issues).toContain("critique.md lists 1 unresolved fixable item(s)");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("[3] discarded → cleanup + rm -rf, no UI", async () => {
    const sessionDir = path.join(tmpDir, "s3");
    writeManifest(sessionDir, baseManifest({ status: "discarded" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    const select = mock(async () => null);
    const { handler, ctx } = registerHook({ select });
    await handler({}, ctx);

    expect(select).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  test("[4] in-progress + Resume → send steer, tracking preserved", async () => {
    const sessionDir = path.join(tmpDir, "s4");
    writeManifest(sessionDir, baseManifest({ status: "in-progress" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHook({
      select: async () => "Resume session",
      sendMessage,
    });
    await handler({}, ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionDir)).toBe(true);

    cancelUiDesignTracking("reset");
    writeManifest(sessionDir, baseManifest({ status: "in-progress" }));
    const cleanup2 = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup2);
    const { handler: handler2, ctx: ctx2 } = registerHook({
      select: async () => "Discard session",
    });
    await handler2({}, ctx2);
    expect(cleanup2).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  test("[5] critiquing resume branch", async () => {
    const sessionDir = path.join(tmpDir, "s5");
    writeManifest(sessionDir, baseManifest({ status: "critiquing" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHook({
      select: async () => "Resume session",
      sendMessage,
    });
    await handler({}, ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(extractSteerText(sendMessage)).toContain("Continue the /supi:ui-design run");
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("[6] awaiting-review resume branch", async () => {
    const sessionDir = path.join(tmpDir, "s6");
    writeManifest(sessionDir, baseManifest({ status: "awaiting-review" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHook({
      select: async () => "Resume session",
      sendMessage,
    });
    await handler({}, ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("[7] missing manifest → single Discard option", async () => {
    const sessionDir = path.join(tmpDir, "s7");
    fs.mkdirSync(sessionDir, { recursive: true });
    const cleanup = mock(async () => {});
    startUiDesignTracking(mkSession(sessionDir), cleanup);

    let seen: string[] | null = null;
    const { handler, ctx } = registerHook({
      select: async (_title, options) => {
        seen = options;
        return "Discard session";
      },
    });
    await handler({}, ctx);

    expect(seen as unknown as string[]).toEqual(["Discard session"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});