import { describe, expect, test } from "vitest";
import {
  fillCommand,
  formatTag,
  releasePipelineTemplate,
  type ReleaseCommandSpec,
} from "../../src/release/pipeline-config";

describe("release pipeline config", () => {
  test("formats tags with template", () => {
    const config = releasePipelineTemplate("node");
    expect(formatTag(config, "1.2.3")).toBe("v1.2.3");
  });

  test("fills command placeholders", () => {
    const spec: ReleaseCommandSpec = {
      command: "git",
      args: ["tag", "{tag}", "{version}"],
    };

    const filled = fillCommand(spec, { version: "2.0.0", tag: "v2.0.0" });
    expect(filled.command).toBe("git");
    expect(filled.args).toEqual(["tag", "v2.0.0", "2.0.0"]);
  });

  test("generic preset uses generic version-bump placeholder", () => {
    const generic = releasePipelineTemplate("generic");
    expect(generic.versionBump.command).toBe("echo");
  });
});
