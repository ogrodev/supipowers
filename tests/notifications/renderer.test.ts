import { describe, test, expect, vi } from "vitest";
import { formatNotification, sendNotification } from "../../src/notifications/renderer.js";

describe("formatNotification", () => {
  test("formats success with icon", () => {
    const result = formatNotification({ level: "success", title: "Task done" });
    expect(result).toContain("\u2713");
    expect(result).toContain("Task done");
  });

  test("includes detail when provided", () => {
    const result = formatNotification({
      level: "error",
      title: "Task failed",
      detail: "missing file",
    });
    expect(result).toContain("Task failed");
    expect(result).toContain("missing file");
  });
});

describe("sendNotification", () => {
  test("calls ctx.ui.notify with correct type", () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    sendNotification(ctx, { level: "error", title: "Oops" });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Oops"), "error");
  });

  test("maps success level to info type", () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    sendNotification(ctx, { level: "success", title: "Done" });
    expect(notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});
