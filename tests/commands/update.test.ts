
import { buildUpdateOptions } from "../../src/commands/update.js";
import type { DependencyStatus } from "../../src/deps/registry.js";

function makeDep(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    name: "test-tool",
    binary: "test-tool",
    required: false,
    category: "mcp",
    description: "A test tool",
    installCmd: "npm install -g test-tool",
    url: "https://example.com",
    installed: false,
    ...overrides,
  };
}

describe("buildUpdateOptions", () => {
  it("returns 4 options with correct missing count", () => {
    const missing: DependencyStatus[] = [
      makeDep({ name: "mcpc", installCmd: "npm install -g @apify/mcpc" }),
      makeDep({ name: "context-mode", installCmd: "npm install -g context-mode" }),
      makeDep({ name: "pyright", installCmd: "pip install pyright" }),
    ];

    const options = buildUpdateOptions(missing);

    expect(options).toHaveLength(4);
    expect(options[0]).toBe("Update supipowers only");
    expect(options[1]).toBe("Update supipowers + install missing tools (3 missing)");
    expect(options[2]).toBe("Update supipowers + reinstall all tools (latest)");
    expect(options[3]).toBe("Cancel");
  });

  it("shows '(all installed)' when no deps are missing", () => {
    const options = buildUpdateOptions([]);

    expect(options).toHaveLength(4);
    expect(options[1]).toBe("Update supipowers + install missing tools (all installed)");
  });

  it("only counts deps with installCmd in the missing count", () => {
    const missing: DependencyStatus[] = [
      makeDep({ name: "Git", installCmd: null }),         // no installCmd — should not count
      makeDep({ name: "bun:sqlite", installCmd: null }),  // no installCmd — should not count
      makeDep({ name: "mcpc", installCmd: "npm install -g @apify/mcpc" }), // has installCmd
    ];

    const options = buildUpdateOptions(missing);

    // Only mcpc has installCmd, so count should be 1
    expect(options[1]).toBe("Update supipowers + install missing tools (1 missing)");
  });

  it("shows '(all installed)' when all missing deps lack installCmd", () => {
    const missing: DependencyStatus[] = [
      makeDep({ name: "Git", installCmd: null }),
      makeDep({ name: "bun:sqlite", installCmd: null }),
    ];

    const options = buildUpdateOptions(missing);

    expect(options[1]).toBe("Update supipowers + install missing tools (all installed)");
  });
});
