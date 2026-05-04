import { describe, expect, test } from "bun:test";

import {
  buildLayerAddendum,
  parseArchitectureMarkdown,
  resolveLayerForFile,
} from "../../../src/harness/anti_slop/architecture-parser.js";

const SAMPLE = `# Architecture

## Layer table

| Layer    | Files                  | Allowed         | Forbidden       | Description |
|----------|------------------------|-----------------|-----------------|-------------|
| domain   | \`src/domain/**\`      | domain          | infra, ui       | Pure types  |
| infra    | \`src/infrastructure/**\` | domain, infra | ui              | I/O layer   |
| ui       | \`src/ui/**\`          | domain, infra, ui | —             | Views       |
`;

describe("parseArchitectureMarkdown", () => {
  test("extracts layer rules from a well-formed table", () => {
    const rules = parseArchitectureMarkdown(SAMPLE);
    expect(rules.length).toBe(3);
    const domain = rules.find((r) => r.layer === "domain");
    expect(domain?.globs).toEqual(["src/domain/**"]);
    expect(domain?.allowedImports).toEqual(["domain"]);
    expect(domain?.forbiddenImports).toEqual(["infra", "ui"]);
    expect(domain?.description).toBe("Pure types");

    const ui = rules.find((r) => r.layer === "ui");
    expect(ui?.forbiddenImports).toEqual([]); // — treated as empty
  });

  test("returns [] for malformed markdown", () => {
    const rules = parseArchitectureMarkdown("just plain text");
    expect(rules).toEqual([]);
  });

  test("ignores trailing tables that don't have a Layer column", () => {
    const md = SAMPLE + "\n\n## Other table\n\n| Foo | Bar |\n|---|---|\n| a | b |\n";
    const rules = parseArchitectureMarkdown(md);
    expect(rules.length).toBe(3);
  });
});

describe("resolveLayerForFile", () => {
  const rules = parseArchitectureMarkdown(SAMPLE);

  test("matches via glob `**`", () => {
    const rule = resolveLayerForFile("src/domain/user.ts", rules);
    expect(rule?.layer).toBe("domain");
  });

  test("returns null for unmatched files", () => {
    const rule = resolveLayerForFile("scripts/migrate.ts", rules);
    expect(rule).toBeNull();
  });
});

describe("buildLayerAddendum", () => {
  const rules = parseArchitectureMarkdown(SAMPLE);
  const domain = rules.find((r) => r.layer === "domain")!;

  test("includes file path, layer, allowed and forbidden lists", () => {
    const addendum = buildLayerAddendum("src/domain/user.ts", domain, 800);
    expect(addendum).toContain("src/domain/user.ts");
    expect(addendum).toContain("domain");
    expect(addendum).toContain("Permitted imports: domain");
    expect(addendum).toContain("Forbidden imports: infra, ui");
  });

  test("truncates with `…` when over max chars", () => {
    const addendum = buildLayerAddendum("src/domain/user.ts", domain, 50);
    expect(addendum.length).toBeLessThanOrEqual(50);
    expect(addendum.endsWith("…")).toBe(true);
  });
});
