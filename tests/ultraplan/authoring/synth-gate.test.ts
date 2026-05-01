import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  runEditorRoundTripOnce,
  runSynthGateLoop,
} from "../../../src/ultraplan/authoring/synth-gate.js";
import {
  saveDraftAuthoredJson,
  loadDraftAuthoredJson,
  loadDraftAuthoredMarkdown,
} from "../../../src/ultraplan/authoring/storage.js";
import {
  getUltraplanAuthoringDraftAuthoredMarkdownPath,
} from "../../../src/ultraplan/project-paths.js";
import { saveUltraPlanManifest } from "../../../src/ultraplan/storage.js";
import { createTestPaths, createTestRepo, makeUltraPlanAuthored, makeUltraPlanManifest } from "../fixtures.js";
import { serializeAuthoredToMarkdown } from "../../../src/ultraplan/authoring/markdown.js";

const SESSION_ID = "up-author-synth-gate-1";
const ITERATION = 1;

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-synth-gate-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
  saveUltraPlanManifest(paths, cwd, SESSION_ID, makeUltraPlanManifest({ sessionId: SESSION_ID }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function platformWithEditor(editorBehaviour: (filePath: string) => void) {
  return {
    paths,
    exec: mock(async (_cmd: string, args: string[]) => {
      const fileArg = args[args.length - 1];
      if (typeof fileArg !== "string") return { stdout: "", stderr: "", code: 0 };
      editorBehaviour(fileArg);
      return { stdout: "", stderr: "", code: 0 };
    }),
  } as any;
}

describe("synth gate — once", () => {
  test("no-changes when the user closes the editor without saving", async () => {
    const draft = makeUltraPlanAuthored({ sessionId: SESSION_ID });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION, draft);
    const platform = platformWithEditor(() => {
      // No-op: the editor closes leaving the file unchanged.
    });
    process.env.EDITOR = "fake-editor";

    const result = await runEditorRoundTripOnce({ platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION });
    expect(result.status).toBe("no-changes");
  });

  test("saved when user edits the title and saves", async () => {
    const draft = makeUltraPlanAuthored({ sessionId: SESSION_ID, title: "Original" });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION, draft);
    const platform = platformWithEditor((filePath) => {
      const md = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, md.replace("title: Original", "title: User-edited"));
    });
    process.env.EDITOR = "fake-editor";

    const result = await runEditorRoundTripOnce({ platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION });
    expect(result.status).toBe("saved");
    if (result.status === "saved") {
      expect(result.authored.title).toBe("User-edited");
    }

    const reloaded = loadDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect((reloaded.value as Record<string, unknown>).title).toBe("User-edited");
  });

  test("parse-failed when the user breaks the markdown structure", async () => {
    const draft = makeUltraPlanAuthored({ sessionId: SESSION_ID });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION, draft);
    const platform = platformWithEditor((filePath) => {
      // Wipe everything; no frontmatter, no content.
      fs.writeFileSync(filePath, "Hello, just a typo!\n");
    });
    process.env.EDITOR = "fake-editor";

    const result = await runEditorRoundTripOnce({ platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION });
    expect(result.status).toBe("parse-failed");

    // Markdown file should now contain the annotation block.
    const annotated = fs.readFileSync(
      getUltraplanAuthoringDraftAuthoredMarkdownPath(paths, cwd, SESSION_ID, ITERATION),
      "utf8",
    );
    expect(annotated.includes("AUTHORED EDIT ERRORS")).toBe(true);
  });

  test("parse-failed when patch references a stack that doesn't exist on the original draft", async () => {
    const draft = makeUltraPlanAuthored({ sessionId: SESSION_ID });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION, draft);
    const platform = platformWithEditor((filePath) => {
      const md = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, md + "\n## Stack: infrastructure\n\n- applicability: applicable\n");
    });
    process.env.EDITOR = "fake-editor";

    const result = await runEditorRoundTripOnce({ platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION });
    expect(result.status).toBe("parse-failed");
  });

  test("io-error surfaced when no draft authored.json exists yet", async () => {
    const platform = platformWithEditor(() => {});
    process.env.EDITOR = "fake-editor";
    const result = await runEditorRoundTripOnce({ platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION });
    expect(result.status).toBe("io-error");
  });
});

describe("synth gate — bounded retry loop", () => {
  test("converges on a successful save after a single fix", async () => {
    const draft = makeUltraPlanAuthored({ sessionId: SESSION_ID, title: "Original" });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION, draft);

    let attempt = 0;
    const platform = platformWithEditor((filePath) => {
      attempt += 1;
      if (attempt === 1) {
        // First attempt: the user saves a broken file.
        fs.writeFileSync(filePath, "broken\n");
      } else {
        // On re-open: the file has the annotated header. The user fixes it by writing a
        // valid markdown.
        fs.writeFileSync(filePath, serializeAuthoredToMarkdown({ ...draft, title: "Fixed" }));
      }
    });
    process.env.EDITOR = "fake-editor";

    const result = await runSynthGateLoop({ platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION });
    expect(result.status).toBe("saved");
    if (result.status === "saved") {
      expect(result.authored.title).toBe("Fixed");
    }
  });

  test("returns the latest parse-failed result after maxParseRetries consecutive failures", async () => {
    const draft = makeUltraPlanAuthored({ sessionId: SESSION_ID });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION, draft);
    let attempt = 0;
    const platform = platformWithEditor((filePath) => {
      attempt += 1;
      // Distinct broken content per attempt so the gate sees a real change every time.
      fs.writeFileSync(filePath, `broken attempt ${attempt}\n`);
    });
    process.env.EDITOR = "fake-editor";

    const result = await runSynthGateLoop({
      platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION, maxParseRetries: 1,
    });
    expect(result.status).toBe("parse-failed");
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  test("on success, the persisted markdown is annotation-free", async () => {
    const draft = makeUltraPlanAuthored({ sessionId: SESSION_ID, title: "T" });
    saveDraftAuthoredJson(paths, cwd, SESSION_ID, ITERATION, draft);
    const platform = platformWithEditor((filePath) => {
      const md = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, md.replace("title: T", "title: T2"));
    });
    process.env.EDITOR = "fake-editor";

    await runEditorRoundTripOnce({ platform, paths, cwd, sessionId: SESSION_ID, iteration: ITERATION });

    const md = loadDraftAuthoredMarkdown(paths, cwd, SESSION_ID, ITERATION);
    expect(md.ok).toBe(true);
    if (md.ok) {
      expect(md.value.includes("AUTHORED EDIT ERRORS")).toBe(false);
    }
  });
});
