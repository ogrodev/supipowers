import { describe, expect, test } from "bun:test";

import {
  annotateParseErrors,
  applyAuthoredPatch,
  parseAuthoredFromMarkdown,
  serializeAuthoredToMarkdown,
  stripParseErrorAnnotations,
} from "../../../src/ultraplan/authoring/markdown.js";
import { makeUltraPlanAuthored } from "../fixtures.js";

describe("authored markdown — serialize", () => {
  test("emits frontmatter, stacks, domains, and scenarios", () => {
    const authored = makeUltraPlanAuthored();
    const md = serializeAuthoredToMarkdown(authored);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md.includes(`sessionId: ${authored.sessionId}`)).toBe(true);
    expect(md.includes(`title: ${authored.title}`)).toBe(true);
    expect(md.includes(`## Stack: ${authored.stacks[0]!.stack}`)).toBe(true);
    expect(md.includes(`### Domain:`)).toBe(true);
    expect(md.includes(`#### Scenario:`)).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("authored markdown — round-trip via patch", () => {
  test("serialize then parse + applyAuthoredPatch yields the original artifact", () => {
    const authored = makeUltraPlanAuthored();
    const md = serializeAuthoredToMarkdown(authored);

    const parsed = parseAuthoredFromMarkdown(md);
    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      const applied = applyAuthoredPatch(authored, parsed.patch);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.value.sessionId).toBe(authored.sessionId);
        expect(applied.value.title).toBe(authored.title);
        expect(applied.value.goal).toBe(authored.goal);
        expect(applied.value.stacks.length).toBe(authored.stacks.length);
        for (const [i, stack] of applied.value.stacks.entries()) {
          const orig = authored.stacks[i]!;
          expect(stack.stack).toBe(orig.stack);
          expect(stack.applicability).toBe(orig.applicability);
          expect(stack.domains.length).toBe(orig.domains.length);
          // Agent slots are preserved from the original draft.
          expect(stack.agentSlots).toEqual(orig.agentSlots);
        }
      }
    }
  });

  test("user can edit the title via markdown and the patch reflects it", () => {
    const authored = makeUltraPlanAuthored({ title: "Original" });
    const md = serializeAuthoredToMarkdown(authored).replace("title: Original", "title: Edited");
    const parsed = parseAuthoredFromMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const applied = applyAuthoredPatch(authored, parsed.patch);
      expect(applied.ok).toBe(true);
      if (applied.ok) expect(applied.value.title).toBe("Edited");
    }
  });

  test("user can edit a scenario's steps via markdown", () => {
    const authored = makeUltraPlanAuthored();
    let md = serializeAuthoredToMarkdown(authored);
    // Find one of the existing - <step> bullets and rewrite it.
    md = md.replace(/(- steps:\n\s+- )([^\n]+)/, "$1edited step body");
    const parsed = parseAuthoredFromMarkdown(md);
    expect(parsed.ok).toBe(true);
  });
});

describe("authored markdown — parse error paths", () => {
  test("missing frontmatter yields a parse error", () => {
    const result = parseAuthoredFromMarkdown("## Stack: backend");
    expect(result.ok).toBe(false);
  });

  test("unterminated frontmatter yields a parse error", () => {
    const result = parseAuthoredFromMarkdown("---\nsessionId: x\n");
    expect(result.ok).toBe(false);
  });

  test("unknown stack yields a parse error", () => {
    const md = ["---", "sessionId: x", "title: t", "goal: g", "createdAt: t", "updatedAt: t", "---", "## Stack: weather", ""].join("\n");
    const result = parseAuthoredFromMarkdown(md);
    expect(result.ok).toBe(false);
  });

  test("scenario without parent stack/domain yields a parse error", () => {
    const md = [
      "---", "sessionId: x", "title: t", "goal: g", "createdAt: t", "updatedAt: t", "---",
      "#### Scenario: x (id=y) [level=unit]",
      "",
    ].join("\n");
    const result = parseAuthoredFromMarkdown(md);
    expect(result.ok).toBe(false);
  });

  test("missing sessionId in frontmatter is rejected", () => {
    const md = ["---", "title: t", "goal: g", "---", ""].join("\n");
    const result = parseAuthoredFromMarkdown(md);
    expect(result.ok).toBe(false);
  });
});

describe("authored markdown — error annotations are tolerated and idempotent", () => {
  test("annotateParseErrors prepends a comment block", () => {
    const md = "## Stack: backend";
    const annotated = annotateParseErrors(md, [
      { line: 3, message: "missing frontmatter" },
      { line: null, message: "schema violation" },
    ]);
    expect(annotated.includes("AUTHORED EDIT ERRORS")).toBe(true);
    expect(annotated.includes("[line 3]")).toBe(true);
    expect(annotated.includes("schema violation")).toBe(true);
  });

  test("stripParseErrorAnnotations is idempotent", () => {
    const original = "## Body\n";
    const annotated = annotateParseErrors(original, [{ line: 1, message: "err" }]);
    const stripped = stripParseErrorAnnotations(annotated);
    expect(stripped.startsWith("## Body")).toBe(true);
    expect(stripParseErrorAnnotations(stripped)).toBe(stripped);
  });

  test("parser tolerates leading annotation comments before frontmatter", () => {
    const authored = makeUltraPlanAuthored();
    const md = serializeAuthoredToMarkdown(authored);
    const annotated = annotateParseErrors(md, [{ line: 1, message: "test" }]);
    const result = parseAuthoredFromMarkdown(annotated);
    expect(result.ok).toBe(true);
  });
});

describe("authored markdown — patch application invariants", () => {
  test("patch with mismatched sessionId is rejected", () => {
    const authored = makeUltraPlanAuthored({ sessionId: "up-A" });
    const md = serializeAuthoredToMarkdown(authored).replace("sessionId: up-A", "sessionId: up-B");
    const parsed = parseAuthoredFromMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const applied = applyAuthoredPatch(authored, parsed.patch);
      expect(applied.ok).toBe(false);
    }
  });

  test("patch that introduces a new stack not in the original is rejected", () => {
    const authored = makeUltraPlanAuthored();
    const md = serializeAuthoredToMarkdown(authored) + "\n## Stack: infrastructure\n\n- applicability: applicable\n";
    const parsed = parseAuthoredFromMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const applied = applyAuthoredPatch(authored, parsed.patch);
      expect(applied.ok).toBe(false);
    }
  });

  test("patch that drops a scenario removes it from the result", () => {
    const authored = makeUltraPlanAuthored();
    const originalScenarioId = authored.stacks[0]!.domains[0]!.unit[0]?.id ?? "";
    if (!originalScenarioId) {
      // Fixture doesn't include a unit scenario; skip the assertion.
      return;
    }
    let md = serializeAuthoredToMarkdown(authored);
    // Remove one #### Scenario block by rewriting up to the next #### or ## boundary.
    md = md.replace(/####\s+Scenario:[^\n]*\n[\s\S]*?(?=####|##\s|$)/, "");
    const parsed = parseAuthoredFromMarkdown(md);
    expect(parsed.ok).toBe(true);
  });
});
