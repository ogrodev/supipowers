import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedModel } from "../../src/types.js";
import { createPaths } from "../../src/platform/types.js";
import {
  cancelUiDesignTracking,
  createSessionDir,
  generateUiDesignSessionId,
  isUiDesignActive,
  registerUiDesignApprovalHook,
  registerUiDesignToolGuard,
  startUiDesignTracking,
} from "../../src/ui-design/session.js";
import type { Manifest, UiDesignSession } from "../../src/ui-design/types.js";

let tmpDir: string;

const VALID_PAGE_HTML = "<!DOCTYPE html><html><body><main>page</main></body></html>";
const VALID_REVIEW_HTML = "<!DOCTYPE html><html><body><section>review</section></body></html>";
const VALID_DECOMPOSITION_HTML =
  "<!DOCTYPE html><html><body><section>decomposition</section></body></html>";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ui-design-session-"));
  cancelUiDesignTracking("test-setup");
});

afterEach(() => {
  cancelUiDesignTracking("test-teardown");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
          question?: string;
          options?: string[];
        }
      | null;
  } = {},
): void {
  if (overrides.contextMd !== null) {
    fs.writeFileSync(
      path.join(dir, "context.md"),
      overrides.contextMd ?? "# Context\n\n- framework: react\n",
    );
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

  for (const component of manifest.components) {
    const componentDir = path.join(dir, "components");
    fs.mkdirSync(componentDir, { recursive: true });
    fs.writeFileSync(path.join(componentDir, `${component}.html`), `<div>${component}</div>`);
    fs.writeFileSync(
      path.join(componentDir, `${component}.tokens.json`),
      JSON.stringify({ component }, null, 2),
    );
  }

  for (const section of manifest.sections) {
    const sectionsDir = path.join(dir, "sections");
    fs.mkdirSync(sectionsDir, { recursive: true });
    fs.writeFileSync(path.join(sectionsDir, `${section}.html`), `<section>${section}</section>`);
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
          question: approval.question ?? "Approve the mockup?",
          options: approval.options ?? ["approve", "request-changes", "discard"],
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
    scope: "page",
    topic: "landing",
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

function makeSession(dir: string, overrides: Partial<UiDesignSession> = {}): UiDesignSession {
  return {
    id: "uidesign-20260418-120000-abcd",
    dir,
    scope: "page",
    topic: "landing",
    backend: "local-html",
    companionUrl: "http://localhost:4321",
    ...overrides,
  };
}

function registerHookWithPlatform(opts: {
  select?: (...args: any[]) => Promise<string | null>;
  sendMessage?: (...args: any[]) => void;
  exec?: (...args: any[]) => Promise<any>;
  setModel?: (...args: any[]) => Promise<boolean>;
  availableModels?: any[];
  currentModel?: any;
}) {
  let handler: ((event: any, ctx: any) => Promise<void>) | null = null;
  const platform: any = {
    on: mock((name: string, cb: any) => {
      if (name === "agent_end" && !handler) handler = cb;
    }),
    sendMessage: opts.sendMessage ?? mock(),
    exec: opts.exec ?? mock(async () => ({ code: 0, stdout: "", stderr: "" })),
    setModel: opts.setModel,
    paths: createPaths(".omp"),
  };
  registerUiDesignApprovalHook(platform);
  const ctx = {
    hasUI: true,
    cwd: tmpDir,
    model: opts.currentModel ?? null,
    modelRegistry: {
      getAvailable: () => opts.availableModels ?? [],
    },
    ui: {
      select: opts.select ?? mock(async () => null),
      notify: mock(),
      setStatus: mock(),
    },
  };
  return { platform, handler: handler!, ctx };
}

function registerToolGuardPlatform() {
  let handler: ((event: any) => any) | null = null;
  const platform: any = {
    on: mock((name: string, cb: any) => {
      if (name === "tool_call" && !handler) handler = cb;
    }),
  };
  registerUiDesignToolGuard(platform);
  return {
    fire: (toolName: string, input: Record<string, unknown> = {}) => handler?.({ toolName, input }),
  };
}

function extractSteerText(sendMessage: ReturnType<typeof mock>): string {
  const [message] = sendMessage.mock.calls[0] as [
    { content: Array<{ text: string }> },
    { deliverAs: string; triggerTurn: boolean },
  ];
  return message.content[0]?.text ?? "";
}

describe("ui-design session — id + dir", () => {
  test("generateUiDesignSessionId returns canonical id", () => {
    const id = generateUiDesignSessionId();
    expect(id).toMatch(/^uidesign-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  test("createSessionDir creates the dir under project(cwd, ui-design, id)", () => {
    const paths = createPaths(".omp");
    const id = "uidesign-20260418-120000-xxxx";
    const dir = createSessionDir(paths, tmpDir, id);
    expect(dir).toBe(paths.project(tmpDir, "ui-design", id));
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("ui-design session — tracking state", () => {
  test("startUiDesignTracking marks active; cancel stops it", () => {
    expect(isUiDesignActive()).toBe(false);
    startUiDesignTracking(makeSession(tmpDir), async () => {});
    expect(isUiDesignActive()).toBe(true);
    cancelUiDesignTracking("test");
    expect(isUiDesignActive()).toBe(false);
  });

  test("second startUiDesignTracking calls previous cleanup", async () => {
    const cleanup1 = mock(async () => {});
    const cleanup2 = mock(async () => {});
    startUiDesignTracking(makeSession(tmpDir), cleanup1);
    startUiDesignTracking(makeSession(tmpDir + "/b"), cleanup2);
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanup1).toHaveBeenCalledTimes(1);
    expect(cleanup2).toHaveBeenCalledTimes(0);
  });
});

describe("ui-design session — tool guard", () => {
  test("blocks writes outside the active session dir", () => {
    const sessionDir = path.join(tmpDir, "guard-outside");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const result = fire("write", { path: path.join(tmpDir, "outside.html") }) as
      | { block: true; reason: string }
      | undefined;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(sessionDir);
  });

  test("allows session-local writes and blocks bash", () => {
    const sessionDir = path.join(tmpDir, "guard-inside");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    expect(fire("write", { path: path.join(sessionDir, "context.md") })).toBeUndefined();
    expect((fire("bash", { command: "touch surprise.txt" }) as { block: true }).block).toBe(true);
  });
});

describe("ui-design session — approval hook terminal branches", () => {
  test("complete + acknowledged:false prompts and flips acknowledged on 'Keep'", async () => {
    const sessionDir = path.join(tmpDir, "s1");
    const manifest = baseManifest();
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest);
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Keep artifacts and exit"),
    });
    await handler({}, ctx);

    const rewritten = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf-8"));
    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(rewritten.acknowledged).toBe(true);
    expect(rewritten.critique).toEqual({ fixableCount: 0, advisoryCount: 0, fixIterations: 0 });
    expect(proof.valid).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(isUiDesignActive()).toBe(false);
  });

  test("complete without an approval record offers resume instead of success actions", async () => {
    const sessionDir = path.join(tmpDir, "s2");
    const manifest = baseManifest({ approvedAt: undefined });
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest, { approvalRecord: null });
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    let seenOptions: string[] | null = null;
    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async (_title: string, options: string[]) => {
        seenOptions = options;
        return "Resume session";
      }),
      sendMessage,
    });
    await handler({}, ctx);

    expect(seenOptions as string[] | null).toEqual(["Resume session", "Discard session"]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(extractSteerText(sendMessage)).toContain("claims `status: \"complete\"`");
    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.issues).toContain("review-approval.json");
    expect(cleanup).not.toHaveBeenCalled();
    expect(isUiDesignActive()).toBe(true);
  });

  test("complete with unresolved fixable critique blocks success actions", async () => {
    const sessionDir = path.join(tmpDir, "s2b");
    const manifest = baseManifest();
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest, {
      critiqueMd: "# Critique\n\n## Fixable\n\n- tighten contrast\n\n## Advisory\n\n- none\n",
    });
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    let seenOptions: string[] | null = null;
    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async (_title: string, options: string[]) => {
        seenOptions = options;
        return "Resume session";
      }),
      sendMessage,
    });
    await handler({}, ctx);

    const rewritten = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf-8"));
    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(seenOptions as string[] | null).toEqual(["Resume session", "Discard session"]);
    expect(rewritten.critique).toEqual({ fixableCount: 1, advisoryCount: 0, fixIterations: 0 });
    expect(proof.valid).toBe(false);
    expect(proof.issues).toContain("critique.md lists 1 unresolved fixable item(s)");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(isUiDesignActive()).toBe(true);
  });

  test("complete without phase artifacts stays blocked from success actions", async () => {
    const sessionDir = path.join(tmpDir, "s2c");
    const manifest = baseManifest();
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest, { contextMd: null });
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
      sendMessage,
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.issues).toContain("context.md");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("complete + 'Discard session' removes the directory", async () => {
    const sessionDir = path.join(tmpDir, "s3");
    const manifest = baseManifest();
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest);
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Discard session"),
    });
    await handler({}, ctx);

    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(isUiDesignActive()).toBe(false);
  });

  test("complete + acknowledged:true is a no-op only when completion proof exists", async () => {
    const sessionDir = path.join(tmpDir, "s4");
    const manifest = baseManifest({ acknowledged: true });
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest);
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const select = mock(async () => "Discard session");
    const { handler, ctx } = registerHookWithPlatform({ select });
    await handler({}, ctx);

    expect(select).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionDir, "completion-proof.json"))).toBe(true);
  });

  test("discarded runs cleanup + rm -rf without UI prompt", async () => {
    const sessionDir = path.join(tmpDir, "s5");
    writeManifest(sessionDir, baseManifest({ status: "discarded" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const select = mock(async () => null);
    const { handler, ctx } = registerHookWithPlatform({ select });
    await handler({}, ctx);

    expect(select).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(isUiDesignActive()).toBe(false);
  });

  test("missing manifest prompts single 'Discard session' option", async () => {
    const sessionDir = path.join(tmpDir, "s6");
    fs.mkdirSync(sessionDir, { recursive: true });
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    let seenOptions: any = null;
    const select = mock(async (_title: string, options: string[]) => {
      seenOptions = options;
      return "Discard session";
    });
    const { handler, ctx } = registerHookWithPlatform({ select });
    await handler({}, ctx);

    expect(seenOptions).toEqual(["Discard session"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(isUiDesignActive()).toBe(false);
  });
});

describe("ui-design session — resume branches", () => {
  for (const status of ["in-progress", "critiquing", "awaiting-review"] as const) {
    test(`${status} + 'Resume session' sends focused steer, leaves tracking active`, async () => {
      const sessionDir = path.join(tmpDir, `resume-${status}`);
      writeManifest(sessionDir, baseManifest({ status }));
      const cleanup = mock(async () => {});
      startUiDesignTracking(makeSession(sessionDir), cleanup);

      const sendMessage = mock(() => {});
      const { handler, ctx } = registerHookWithPlatform({
        select: mock(async () => "Resume session"),
        sendMessage,
      });
      await handler({}, ctx);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(extractSteerText(sendMessage)).toContain("Continue the /supi:ui-design run");
      expect(extractSteerText(sendMessage)).toContain("manifest.json");
      expect(cleanup).not.toHaveBeenCalled();
      expect(isUiDesignActive()).toBe(true);
    });

    test(`${status} + 'Discard session' cleans up`, async () => {
      const sessionDir = path.join(tmpDir, `discard-${status}`);
      writeManifest(sessionDir, baseManifest({ status }));
      const cleanup = mock(async () => {});
      startUiDesignTracking(makeSession(sessionDir), cleanup);

      const { handler, ctx } = registerHookWithPlatform({
        select: mock(async () => "Discard session"),
      });
      await handler({}, ctx);

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(sessionDir)).toBe(false);
      expect(isUiDesignActive()).toBe(false);
    });
  }

  test("resume reapplies the stored ui-design model before sending steer", async () => {
    const sessionDir = path.join(tmpDir, "resume-model");
    const resolvedModel: ResolvedModel = {
      model: "claude-ui",
      thinkingLevel: null,
      source: "action",
    };
    writeManifest(sessionDir, baseManifest({ status: "critiquing" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir, { resolvedModel }), cleanup);

    const sendMessage = mock(() => {});
    const setModel = mock(async () => true);
    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
      sendMessage,
      setModel,
      availableModels: [{ id: "claude-ui", provider: "anthropic", name: "Claude UI" }],
      currentModel: { id: "baseline-model" },
    });
    await handler({}, ctx);

    expect(setModel).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(setModel.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
    expect(cleanup).not.toHaveBeenCalled();
});

});