import { recordUiDesignReviewApproval } from "../../src/ui-design/session.js";

import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedModel } from "../../src/types.js";
import { createPaths } from "../../src/platform/types.js";
import { createHermeticPaths, expectedProjectStatePath } from "../helpers/paths.js";
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
  hasUI?: boolean;
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
    hasUI: opts.hasUI ?? true,
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

  test("createSessionDir creates the dir under the project-scoped global state root", () => {
    const paths = createHermeticPaths(tmpDir);
    const id = "uidesign-20260418-120000-xxxx";
    const dir = createSessionDir(paths, tmpDir, id);
    expect(dir).toBe(expectedProjectStatePath(paths, tmpDir, "ui-design", id));
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

  test("blocks native resolve plan approval", () => {
    const sessionDir = path.join(tmpDir, "guard-resolve-approval");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const result = fire("resolve", { action: "apply", extra: { title: "native_plan" } }) as
      | { block: true; reason: string }
      | undefined;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("agent_end approval hook");
    expect(result?.reason).toContain("extra.title");
  });

  test("allows ordinary resolve calls", () => {
    const sessionDir = path.join(tmpDir, "guard-resolve-ordinary");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    expect(fire("resolve", { action: "apply" })).toBeUndefined();
  });

  test("validates every edit operation path under the active session dir", () => {
    const sessionDir = path.join(tmpDir, "guard-edit");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const insidePath = path.join(sessionDir, "context.md");

    expect(fire("edit", { edits: [{ path: insidePath, content: "ok" }] })).toBeUndefined();

    const outside = fire("edit", {
      edits: [
        { path: insidePath, content: "ok" },
        { path: path.join(tmpDir, "outside.md"), content: "bad" },
      ],
    }) as { block: true; reason: string } | undefined;
    expect(outside?.block).toBe(true);
    expect(outside?.reason).toContain("may only write");

    const missingPath = fire("edit", { edits: [{ content: "missing path" }] }) as
      | { block: true; reason: string }
      | undefined;
    expect(missingPath?.block).toBe(true);
    expect(missingPath?.reason).toContain("cannot verify edit");
  });

  test("ast_edit single literal path with spaces inside session dir is allowed", () => {
    const sessionDir = path.join(tmpDir, "guard ast edit inside");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    expect(fire("ast_edit", { paths: [path.join(sessionDir, "app shell.tsx")] })).toBeUndefined();
  });

  test("ast_edit paths array all inside session dir is allowed", () => {
    const sessionDir = path.join(tmpDir, "guard-ast-edit-list");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const paths = [path.join(sessionDir, "a.tsx"), path.join(sessionDir, "b.tsx")];
    expect(fire("ast_edit", { paths })).toBeUndefined();
  });

  test("ast_edit paths array with one path outside is blocked", () => {
    const sessionDir = path.join(tmpDir, "guard-ast-edit-escape");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const mix = [path.join(sessionDir, "a.tsx"), path.join(tmpDir, "outside.tsx")];
    const result = fire("ast_edit", { paths: mix }) as { block: true; reason: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("may only write");
  });

  test("ast_edit glob path is blocked with a glob-specific reason", () => {
    const sessionDir = path.join(tmpDir, "guard-ast-edit-glob");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const glob = path.join(sessionDir, "**/*.tsx");
    const result = fire("ast_edit", { paths: [glob] }) as { block: true; reason: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("cannot use glob pattern");
  });

  test("ast_edit bracket and brace glob patterns are blocked", () => {
    const sessionDir = path.join(tmpDir, "guard-ast-edit-glob-meta");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const bracketEscape = path.join(sessionDir, "[.][.]", "outside.tsx");
    const bracePattern = path.join(sessionDir, "{a,b}.tsx");

    const bracketResult = fire("ast_edit", { paths: [bracketEscape] }) as { block: true; reason: string } | undefined;
    expect(bracketResult?.block).toBe(true);
    expect(bracketResult?.reason).toContain("cannot use glob pattern");

    const braceResult = fire("ast_edit", { paths: [bracePattern] }) as { block: true; reason: string } | undefined;
    expect(braceResult?.block).toBe(true);
    expect(braceResult?.reason).toContain("cannot use glob pattern");
  });

  test("ast_edit empty path is blocked with verify-without-path reason", () => {
    const sessionDir = path.join(tmpDir, "guard-ast-edit-empty");
    fs.mkdirSync(sessionDir, { recursive: true });
    startUiDesignTracking(makeSession(sessionDir), async () => {});

    const { fire } = registerToolGuardPlatform();
    const result = fire("ast_edit", { paths: [""] }) as { block: true; reason: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("cannot verify ast_edit");
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

describe("ui-design session — no-UI approval hook handling", () => {
  test("missing manifest cleans up companion but preserves artifacts", async () => {
    const sessionDir = path.join(tmpDir, "no-ui-missing");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "scratch.txt"), "keep");
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const select = mock(async () => "Discard session");
    const { handler, ctx } = registerHookWithPlatform({ select, hasUI: false });
    await handler({}, ctx);

    expect(select).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "scratch.txt"))).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("artifacts preserved"),
      "warning",
    );
    expect(isUiDesignActive()).toBe(false);
  });

  test("valid complete manifest is acknowledged without prompting or deleting artifacts", async () => {
    const sessionDir = path.join(tmpDir, "no-ui-complete");
    const manifest = baseManifest();
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest);
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const select = mock(async () => "Discard session");
    const { handler, ctx } = registerHookWithPlatform({ select, hasUI: false });
    await handler({}, ctx);

    const rewritten = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf-8"));
    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(select).not.toHaveBeenCalled();
    expect(rewritten.acknowledged).toBe(true);
    expect(proof.valid).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(isUiDesignActive()).toBe(false);
  });

  test("invalid complete manifest sends repair steer and keeps tracking active", async () => {
    const sessionDir = path.join(tmpDir, "no-ui-invalid-complete");
    const manifest = baseManifest({ approvedAt: undefined });
    writeManifest(sessionDir, manifest);
    writeCompletionArtifacts(sessionDir, manifest, { approvalRecord: null });
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({ sendMessage, hasUI: false });
    await handler({}, ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(extractSteerText(sendMessage)).toContain("claims `status: \"complete\"`");
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(isUiDesignActive()).toBe(true);
  });

  test("discarded manifest removes the session directory without prompting", async () => {
    const sessionDir = path.join(tmpDir, "no-ui-discarded");
    writeManifest(sessionDir, baseManifest({ status: "discarded" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const select = mock(async () => "Discard session");
    const { handler, ctx } = registerHookWithPlatform({ select, hasUI: false });
    await handler({}, ctx);

    expect(select).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(isUiDesignActive()).toBe(false);
  });

  test("no-progress resume status pauses visibly, cleans up, and preserves artifacts", async () => {
    const sessionDir = path.join(tmpDir, "no-ui-paused");
    writeManifest(sessionDir, baseManifest({ status: "awaiting-review" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({ sendMessage, hasUI: false });
    await handler({}, ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message, opts] = sendMessage.mock.calls[0] as unknown as [
      { customType: string; display: boolean; content: Array<{ text: string }> },
      { deliverAs: string; triggerTurn: boolean },
    ];
    expect(message.customType).toBe("supi-ui-design-paused-no-ui");
    expect(message.display).toBe(true);
    expect(message.content[0].text).toContain(sessionDir);
    expect(opts).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(isUiDesignActive()).toBe(false);
  });

  test("progressing resume status auto-resumes when same-size artifact content changes", async () => {
    const sessionDir = path.join(tmpDir, "no-ui-progress");
    const manifestPath = path.join(sessionDir, "manifest.json");
    const fixedTimestamp = new Date("2026-04-18T00:00:00.000Z");
    writeManifest(sessionDir, baseManifest({ status: "in-progress" }));
    fs.utimesSync(manifestPath, fixedTimestamp, fixedTimestamp);
    fs.utimesSync(sessionDir, fixedTimestamp, fixedTimestamp);
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);
    writeManifest(sessionDir, baseManifest({ status: "in-progress", topic: "changed" }));
    fs.utimesSync(manifestPath, fixedTimestamp, fixedTimestamp);
    fs.utimesSync(sessionDir, fixedTimestamp, fixedTimestamp);

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({ sendMessage, hasUI: false });
    await handler({}, ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(extractSteerText(sendMessage)).toContain("Continue the /supi:ui-design run");
    expect(cleanup).not.toHaveBeenCalled();
    expect(isUiDesignActive()).toBe(true);
  });
});

describe("ui-design session — resume branches", () => {
  test("in-progress auto-resumes when the session artifacts changed since tracking started", async () => {
    const sessionDir = path.join(tmpDir, "resume-progress");
    writeManifest(sessionDir, baseManifest({ status: "in-progress" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    writeManifest(sessionDir, baseManifest({
      status: "in-progress",
      scope: "page",
      topic: "landing refined",
    }));

    const sendMessage = mock(() => {});
    const select = mock(async () => "Discard session");
    const { handler, ctx } = registerHookWithPlatform({ select, sendMessage });
    await handler({}, ctx);

    expect(select).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(extractSteerText(sendMessage)).toContain("Continue the /supi:ui-design run");
    expect(cleanup).not.toHaveBeenCalled();
    expect(isUiDesignActive()).toBe(true);
  });

  test("after an auto-resume, a later unchanged turn prompts instead of looping", async () => {
    const sessionDir = path.join(tmpDir, "resume-progress-once");
    writeManifest(sessionDir, baseManifest({ status: "in-progress" }));
    const cleanup = mock(async () => {});
    startUiDesignTracking(makeSession(sessionDir), cleanup);

    writeManifest(sessionDir, baseManifest({
      status: "in-progress",
      scope: "page",
      topic: "landing refined",
    }));

    const sendMessage = mock(() => {});
    const select = mock(async () => null);
    const { handler, ctx } = registerHookWithPlatform({ select, sendMessage });

    await handler({}, ctx);
    await handler({}, ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(isUiDesignActive()).toBe(true);
  });

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

describe("ui-design session — pencil-mcp completion validation", () => {
  function writePencilCompletionArtifacts(
    dir: string,
    overrides: {
      contextMd?: string | null;
      decompositionJson?: string | null;
      nodeManifest?: unknown | null;
      critiqueMd?: string | null;
      screenReviewPng?: Buffer | null;
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
    fs.mkdirSync(dir, { recursive: true });
    if (overrides.contextMd !== null) {
      fs.writeFileSync(
        path.join(dir, "context.md"),
        overrides.contextMd ?? "# Context\n\n- framework: react\n",
      );
    }
    if (overrides.decompositionJson !== null) {
      fs.writeFileSync(
        path.join(dir, "decomposition.json"),
        overrides.decompositionJson ?? JSON.stringify({ components: [], sections: [] }, null, 2),
      );
    }
    if (overrides.nodeManifest !== null) {
      const nm = overrides.nodeManifest ?? {
        pageNodeId: "page-1",
        sectionNodeIds: ["sec-1"],
        componentNodeIds: ["cmp-1"],
      };
      fs.writeFileSync(path.join(dir, "node-manifest.json"), JSON.stringify(nm, null, 2));
    }
    if (overrides.critiqueMd !== null) {
      fs.writeFileSync(
        path.join(dir, "critique.md"),
        overrides.critiqueMd ?? "# Critique\n\n## Fixable\n\n- none\n\n## Advisory\n\n- none\n",
      );
    }
    if (overrides.screenReviewPng !== null) {
      fs.writeFileSync(
        path.join(dir, "screen-review.png"),
        overrides.screenReviewPng ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
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

  function pencilManifest(overrides: Partial<Manifest> = {}): Manifest {
    return {
      id: "uidesign-20260418-120000-pen1",
      scope: "page",
      topic: "landing",
      backend: "pencil-mcp",
      status: "complete",
      acknowledged: false,
      createdAt: "2026-04-18T00:00:00.000Z",
      approvedAt: "2026-04-18T00:05:00.000Z",
      components: [],
      sections: [],
      page: "page.html", // unused for pencil sessions but keeps the schema shape
      ...overrides,
    };
  }

  test("happy path: session-local .pen + all artifacts → completion-proof.valid=true", async () => {
    const sessionDir = path.join(tmpDir, "pen-happy");
    const penPath = path.join(sessionDir, "design.pen");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(penPath, "");
    const manifest = pencilManifest({ penFilePath: penPath });
    writeManifest(sessionDir, manifest);
    writePencilCompletionArtifacts(sessionDir);
    const cleanup = mock(async () => {});
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: penPath }),
      cleanup,
    );

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Keep artifacts and exit"),
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.valid).toBe(true);
    expect(proof.issues).toEqual([]);
    expect(proof.reviewPath).toBe("screen-review.png");
    expect(proof.penFilePath).toBe(penPath);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("out-of-session .pen path is honored when it exists on disk", async () => {
    const sessionDir = path.join(tmpDir, "pen-external");
    const externalPenPath = path.join(tmpDir, "external-design.pen");
    fs.writeFileSync(externalPenPath, "");
    const manifest = pencilManifest({ penFilePath: externalPenPath });
    writeManifest(sessionDir, manifest);
    writePencilCompletionArtifacts(sessionDir);
    const cleanup = mock(async () => {});
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: externalPenPath }),
      cleanup,
    );

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Keep artifacts and exit"),
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.valid).toBe(true);
    expect(proof.penFilePath).toBe(externalPenPath);

    // The external .pen file is NOT deleted by the hook.
    expect(fs.existsSync(externalPenPath)).toBe(true);
  });

  test("missing .pen file on disk blocks success actions", async () => {
    const sessionDir = path.join(tmpDir, "pen-missing");
    const penPath = path.join(tmpDir, "never-created.pen");
    const manifest = pencilManifest({ penFilePath: penPath });
    writeManifest(sessionDir, manifest);
    writePencilCompletionArtifacts(sessionDir);
    const cleanup = mock(async () => {});
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: penPath }),
      cleanup,
    );

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
      sendMessage,
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.valid).toBe(false);
    expect(proof.issues.some((i: string) => i.includes("penFilePath missing on disk"))).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const steer = extractSteerText(sendMessage);
    expect(steer).toContain("mcp__pencil_open_document");
    expect(steer).toContain(penPath);
  });

  test("missing manifest.penFilePath raises an issue", async () => {
    const sessionDir = path.join(tmpDir, "pen-no-field");
    const manifest = pencilManifest(); // penFilePath omitted
    writeManifest(sessionDir, manifest);
    writePencilCompletionArtifacts(sessionDir);
    startUiDesignTracking(makeSession(sessionDir, { backend: "pencil-mcp" }), mock(async () => {}));

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.valid).toBe(false);
    expect(proof.issues).toContain("manifest.penFilePath missing");
  });

  test("missing node-manifest.json is reported", async () => {
    const sessionDir = path.join(tmpDir, "pen-no-node-manifest");
    const penPath = path.join(sessionDir, "design.pen");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(penPath, "");
    const manifest = pencilManifest({ penFilePath: penPath });
    writeManifest(sessionDir, manifest);
    writePencilCompletionArtifacts(sessionDir, { nodeManifest: null });
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: penPath }),
      mock(async () => {}),
    );

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.issues).toContain("node-manifest.json");
  });

  test("malformed node-manifest.json is reported", async () => {
    const sessionDir = path.join(tmpDir, "pen-bad-node-manifest");
    const penPath = path.join(sessionDir, "design.pen");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(penPath, "");
    const manifest = pencilManifest({ penFilePath: penPath });
    writeManifest(sessionDir, manifest);
    writePencilCompletionArtifacts(sessionDir, {
      nodeManifest: { pageNodeId: "p1" /* missing arrays */ },
    });
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: penPath }),
      mock(async () => {}),
    );

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.valid).toBe(false);
    expect(proof.issues.some((i: string) => i.includes("node-manifest.json is malformed"))).toBe(true);
  });

  test("missing screen-review.png is reported", async () => {
    const sessionDir = path.join(tmpDir, "pen-no-png");
    const penPath = path.join(sessionDir, "design.pen");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(penPath, "");
    const manifest = pencilManifest({ penFilePath: penPath });
    writeManifest(sessionDir, manifest);
    writePencilCompletionArtifacts(sessionDir, { screenReviewPng: null });
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: penPath }),
      mock(async () => {}),
    );

    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
    });
    await handler({}, ctx);

    const proof = JSON.parse(fs.readFileSync(path.join(sessionDir, "completion-proof.json"), "utf-8"));
    expect(proof.issues).toContain("screen-review.png");
  });
});


describe("ui-design session — review approval recording across backends", () => {
  const DECISION_OPTIONS = ["approve", "request-changes", "discard"];

  test("pencil sessions persist the approval record when screen-review.png exists", () => {
    const sessionDir = path.join(tmpDir, "record-pencil");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "screen-review.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: path.join(sessionDir, "design.pen") }),
      mock(async () => {}),
    );

    recordUiDesignReviewApproval("Approve?", DECISION_OPTIONS, "approve");

    const approvalPath = path.join(sessionDir, "review-approval.json");
    expect(fs.existsSync(approvalPath)).toBe(true);
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8"));
    expect(approval.selected).toBe("approve");
  });

  test("pencil sessions DO NOT persist approval when only screen-review.html exists", () => {
    const sessionDir = path.join(tmpDir, "record-pencil-wrong-artifact");
    fs.mkdirSync(sessionDir, { recursive: true });
    // wrong artifact for pencil backend — the guard should reject
    fs.writeFileSync(path.join(sessionDir, "screen-review.html"), "<html></html>");
    startUiDesignTracking(
      makeSession(sessionDir, { backend: "pencil-mcp", penFilePath: path.join(sessionDir, "design.pen") }),
      mock(async () => {}),
    );

    recordUiDesignReviewApproval("Approve?", DECISION_OPTIONS, "approve");

    expect(fs.existsSync(path.join(sessionDir, "review-approval.json"))).toBe(false);
  });

  test("local-html sessions still gate on screen-review.html", () => {
    const sessionDir = path.join(tmpDir, "record-html");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "screen-review.html"), "<!doctype html><html></html>");
    startUiDesignTracking(makeSession(sessionDir), mock(async () => {}));

    recordUiDesignReviewApproval("Approve?", DECISION_OPTIONS, "approve");

    expect(fs.existsSync(path.join(sessionDir, "review-approval.json"))).toBe(true);
  });

  test("local-html sessions do not persist approval on a png-only directory", () => {
    const sessionDir = path.join(tmpDir, "record-html-wrong");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "screen-review.png"), Buffer.from([0x89, 0x50]));
    startUiDesignTracking(makeSession(sessionDir), mock(async () => {}));

    recordUiDesignReviewApproval("Approve?", DECISION_OPTIONS, "approve");

    expect(fs.existsSync(path.join(sessionDir, "review-approval.json"))).toBe(false);
  });
});

describe("ui-design session — pencil repair steer template", () => {
  test("pencil manifest with missing penFilePath still gets the pencil repair steer", async () => {
    const sessionDir = path.join(tmpDir, "pen-repair-no-path");
    // backend=pencil-mcp, penFilePath deliberately omitted
    writeManifest(sessionDir, {
      id: "x",
      backend: "pencil-mcp",
      status: "complete",
      acknowledged: false,
      createdAt: "2026-04-18T00:00:00.000Z",
      components: [],
      sections: [],
      page: "page.html",
    });
    // Intentionally no pencil artifacts — validation will fail and prompt Resume.
    startUiDesignTracking(makeSession(sessionDir, { backend: "pencil-mcp" }), mock(async () => {}));

    const sendMessage = mock(() => {});
    const { handler, ctx } = registerHookWithPlatform({
      select: mock(async () => "Resume session"),
      sendMessage,
    });
    await handler({}, ctx);

    const steer = extractSteerText(sendMessage);
    // Must cite pencil-world artifacts, not page.html / screen-review.html.
    expect(steer).toContain("node-manifest.json");
    expect(steer).toContain("screen-review.png");
    expect(steer).not.toContain("page.html");
    expect(steer).not.toContain("screen-review.html");
    // Must direct the director to recover the path from manifest.json.
    expect(steer).toContain("manifest.json");
  });
});
