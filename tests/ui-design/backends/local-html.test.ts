import { describe, expect, mock, test } from "bun:test";
import { createLocalHtmlBackend } from "../../../src/ui-design/backends/local-html.js";
import { BackendUnavailableError } from "../../../src/ui-design/backend-adapter.js";

function makeDeps(overrides: Partial<Parameters<typeof createLocalHtmlBackend>[0]> = {}) {
  return {
    startVisualServer: overrides.startVisualServer ??
      mock(async () => ({ url: "http://localhost:4321", port: 4321, host: "localhost", screenDir: "/tmp" })),
    stopVisualServer: overrides.stopVisualServer ?? mock(() => ({ status: "stopped" as const })),
  };
}

describe("local-html backend", () => {
  test("startSession forwards sessionDir to startVisualServer", async () => {
    const deps = makeDeps();
    const backend = createLocalHtmlBackend(deps);
    const result = await backend.startSession({ sessionDir: "/sess" });
    expect(result.url).toBe("http://localhost:4321");
    expect(deps.startVisualServer).toHaveBeenCalledWith({ sessionDir: "/sess" });
  });

  test("startSession forwards sessionDir and port", async () => {
    const deps = makeDeps();
    const backend = createLocalHtmlBackend(deps);
    await backend.startSession({ sessionDir: "/sess", port: 5555 });
    expect(deps.startVisualServer).toHaveBeenCalledWith({ sessionDir: "/sess", port: 5555 });
  });

  test("cleanup is idempotent", async () => {
    const deps = makeDeps();
    const backend = createLocalHtmlBackend(deps);
    const result = await backend.startSession({ sessionDir: "/sess" });
    await result.cleanup();
    await result.cleanup();
    expect(deps.stopVisualServer).toHaveBeenCalledTimes(1);
  });

  test("artifactUrl appends the path to the base url", async () => {
    const deps = makeDeps();
    const backend = createLocalHtmlBackend(deps);
    await backend.startSession({ sessionDir: "/sess" });
    expect(backend.artifactUrl("/sess", "page.html")).toBe("http://localhost:4321/page.html");
  });

  test("artifactUrl returns null without a matching active session", async () => {
    const deps = makeDeps();
    const backend = createLocalHtmlBackend(deps);

    expect(backend.artifactUrl("/sess", "page.html")).toBeNull();
    await backend.startSession({ sessionDir: "/sess" });
    await backend.finalize("/sess", "complete");
    expect(backend.artifactUrl("/sess", "page.html")).toBeNull();
  });

  test("finalize(complete) stops the server without touching manifest", async () => {
    const deps = makeDeps();
    const backend = createLocalHtmlBackend(deps);
    await backend.startSession({ sessionDir: "/sess" });
    await backend.finalize("/sess", "complete");
    expect(deps.stopVisualServer).toHaveBeenCalledTimes(1);
  });

  test("finalize(discarded) stops the server without touching manifest", async () => {
    const deps = makeDeps();
    const backend = createLocalHtmlBackend(deps);
    await backend.startSession({ sessionDir: "/sess" });
    await backend.finalize("/sess", "discarded");
    expect(deps.stopVisualServer).toHaveBeenCalledTimes(1);
  });

  test("startSession throws BackendUnavailableError when server fails", async () => {
    const deps = makeDeps({ startVisualServer: mock(async () => null) });
    const backend = createLocalHtmlBackend(deps);
    expect(backend.startSession({ sessionDir: "/sess" })).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});
