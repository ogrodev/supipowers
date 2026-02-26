import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseSetupArgs } from "../../src/commands/sp-release-setup";
import {
  detectReleasePreset,
  releasePipelineTemplate,
  saveReleasePipeline,
  loadReleasePipeline,
} from "../../src/release/pipeline-config";

describe("sp-release-setup", () => {
  test("parses preset and force flag", () => {
    expect(parseSetupArgs("node --force")).toEqual({ preset: "node", force: true });
    expect(parseSetupArgs("--force")).toEqual({ preset: undefined, force: true });
    expect(parseSetupArgs("python")).toEqual({ preset: "python", force: false });
  });

  test("detects node preset from package.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-setup-node-"));
    writeFileSync(join(cwd, "package.json"), "{}\n", "utf-8");

    expect(detectReleasePreset(cwd)).toBe("node");
  });

  test("writes and reloads release pipeline config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-setup-save-"));
    const template = releasePipelineTemplate("generic");
    const path = saveReleasePipeline(cwd, template);
    const loaded = loadReleasePipeline(cwd);

    expect(path.endsWith("release.pipeline.json")).toBe(true);
    expect(loaded?.preset).toBe("generic");
    expect(loaded?.tagFormat).toBe("v{version}");
  });
});
