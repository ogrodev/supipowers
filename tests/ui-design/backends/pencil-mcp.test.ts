import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPencilMcpBackend,
  detectPencilMcp,
  REQUIRED_PENCIL_TOOLS,
} from "../../../src/ui-design/backends/pencil-mcp.js";
import { BackendUnavailableError } from "../../../src/ui-design/backend-adapter.js";

const PEN_ABSOLUTE = path.resolve("/tmp/supi-ui-design-test.pen");

function pencilTools(): string[] {
  return [...REQUIRED_PENCIL_TOOLS];
}

describe("detectPencilMcp", () => {
  test("returns true when required tools are present", () => {
    expect(detectPencilMcp(pencilTools())).toBe(true);
  });

  test("returns false when one of the required tools is missing", () => {
    const withoutExport = REQUIRED_PENCIL_TOOLS.filter((tool) => tool !== "mcp__pencil_export_nodes");
    expect(detectPencilMcp(withoutExport)).toBe(false);
  });

  test("returns false on empty or non-array input", () => {
    expect(detectPencilMcp([])).toBe(false);
    expect(detectPencilMcp(undefined as unknown as string[])).toBe(false);
  });

  test("ignores unrelated tools", () => {
    expect(detectPencilMcp(["read", "write", "grep"])).toBe(false);
  });
});

describe("pencil-mcp backend", () => {
  test("id is pencil-mcp", () => {
    const backend = createPencilMcpBackend({ getActiveTools: pencilTools });
    expect(backend.id).toBe("pencil-mcp");
  });

  test("startSession throws when pencil tools are not connected", async () => {
    const backend = createPencilMcpBackend({ getActiveTools: () => [] });
    await expect(
      backend.startSession({ sessionDir: "/sess", penFilePath: PEN_ABSOLUTE }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  test("startSession throws when penFilePath is missing or relative", async () => {
    const backend = createPencilMcpBackend({ getActiveTools: pencilTools });
    await expect(
      backend.startSession({ sessionDir: "/sess" } as any),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(
      backend.startSession({ sessionDir: "/sess", penFilePath: "relative/design.pen" }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  test("startSession returns a file:// url for the pen file", async () => {
    const backend = createPencilMcpBackend({ getActiveTools: pencilTools });
    const result = await backend.startSession({
      sessionDir: "/sess",
      penFilePath: PEN_ABSOLUTE,
    });
    expect(result.url).toBe(pathToFileURL(PEN_ABSOLUTE).toString());
  });

  test("cleanup is idempotent", async () => {
    const backend = createPencilMcpBackend({ getActiveTools: pencilTools });
    const result = await backend.startSession({
      sessionDir: "/sess",
      penFilePath: PEN_ABSOLUTE,
    });
    await result.cleanup();
    await result.cleanup();
    // no throws, no assertions on count — cleanup is a pure no-op by design
  });

  test("artifactUrl returns file:// URL for session-local artifacts", async () => {
    const backend = createPencilMcpBackend({ getActiveTools: pencilTools });
    await backend.startSession({ sessionDir: "/sess", penFilePath: PEN_ABSOLUTE });
    const url = backend.artifactUrl("/sess", "critique.md");
    expect(url).toBe(pathToFileURL(path.join("/sess", "critique.md")).toString());
  });

  test("artifactUrl returns null without a matching active session", async () => {
    const backend = createPencilMcpBackend({ getActiveTools: pencilTools });
    expect(backend.artifactUrl("/sess", "critique.md")).toBeNull();
    await backend.startSession({ sessionDir: "/sess", penFilePath: PEN_ABSOLUTE });
    await backend.finalize("/sess", "complete");
    expect(backend.artifactUrl("/sess", "critique.md")).toBeNull();
  });

  test("finalize never throws and does not error on repeat calls", async () => {
    const backend = createPencilMcpBackend({ getActiveTools: pencilTools });
    await backend.startSession({ sessionDir: "/sess", penFilePath: PEN_ABSOLUTE });
    await backend.finalize("/sess", "complete");
    await backend.finalize("/sess", "discarded");
  });
});
