import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ParsedSkill, PromptSection } from "../../src/context/analyzer.js";
import type { TechStack } from "../../src/context/optimizer.js";
import {
  TARGET_STARTUP_PROMPT_BYTES,
  buildOptimizationPlan,
  hashOptimizationSource,
  slugifyOptimizationSource,
} from "../../src/context/startup-optimizer.js";

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function skill(name: string, body: string): ParsedSkill {
  const content = `## ${name}\n${body}`;
  return {
    name,
    content,
    bytes: bytes(content),
    tokens: Math.ceil(content.length / 4),
  };
}

function section(label: string, content: string): PromptSection {
  return {
    label,
    content,
    bytes: bytes(content),
  };
}

const TYPESCRIPT_STACK: TechStack = {
  languages: ["typescript"],
  frameworks: [],
  tools: [],
  runtime: "bun",
};

const TTSR_CASES: Record<string, { positives: string[]; negatives: string[] }> = {
  debugging: {
    positives: [
      "debug this failing test",
      "find the root cause before fixing",
      "investigate why the command crashes",
    ],
    negatives: ["design a dashboard", "write release notes"],
  },
  tdd: {
    positives: [
      "use TDD for this bug fix",
      "write the test first",
      "follow red-green-refactor",
    ],
    negatives: ["summarize this file", "open the config panel"],
  },
  verification: {
    positives: [
      "verify the fix with evidence",
      "run the focused tests before completion",
      "prove the behavior changed",
    ],
    negatives: ["brainstorm names", "choose a color palette"],
  },
  "receiving-code-review": {
    positives: [
      "address this PR feedback",
      "triage these code review comments",
      "respond to reviewer feedback",
    ],
    negatives: ["perform a fresh security review", "write the README"],
  },
};

describe("buildOptimizationPlan", () => {
  test("builds deterministic write-rule, manual-disable, and AGENTS split actions", () => {
    const skills = [
      skill("debugging", "Systematic debugging methodology."),
      skill("tdd", "Write failing tests first."),
      skill("verification", "Evidence before claims."),
      skill("receiving-code-review", "Verify reviewer comments before applying them."),
      skill("shadcn-ui", "React component implementation reference."),
      skill("database-reference", "Occasional lookup material for migration syntax."),
    ];
    const sections = [
      section("Base system prompt", "You are an OMP coding agent."),
      section("AGENTS.md", `# Repo rules\n${"Split me.\n".repeat(4_200)}`),
    ];

    const prompt = `You are an OMP coding agent.\n${skills.map((s) => s.content).join("\n")}`;
    const plan = buildOptimizationPlan({
      prompt,
      sections,
      skills,
      techStack: TYPESCRIPT_STACK,
    });

    expect(plan.targetBytes).toBe(8_000 * 4);
    expect(plan.targetBytes).toBe(TARGET_STARTUP_PROMPT_BYTES);

    const writeRules = plan.actions.filter((action) => action.kind === "write-rule");
    expect(writeRules.map((action) => `${action.mode}:${action.sourceName}`).sort()).toEqual([
      "rulebook:database-reference",
      "ttsr:debugging",
      "ttsr:receiving-code-review",
      "ttsr:tdd",
      "ttsr:verification",
    ]);

    const ttsrRules = writeRules.filter((action) => action.mode === "ttsr");
    expect(ttsrRules.map((action) => action.sourceName).sort()).toEqual([
      "debugging",
      "receiving-code-review",
      "tdd",
      "verification",
    ]);

    const rulebookRules = writeRules.filter((action) => action.mode === "rulebook");
    expect(rulebookRules.map((action) => action.sourceName)).toEqual(["database-reference"]);

    const manualDisables = plan.actions.filter((action) => action.kind === "manual-disable");
    expect(manualDisables.map((action) => `${action.sourceName}:${action.reason}`).sort()).toEqual([
      "database-reference:source-still-loaded",
      "debugging:source-still-loaded",
      "receiving-code-review:source-still-loaded",
      "shadcn-ui:tech-stack-irrelevant",
      "tdd:source-still-loaded",
      "verification:source-still-loaded",
    ]);

    const agentsSplit = plan.actions.find((action) => action.kind === "manual-agents-split");
    expect(agentsSplit).toMatchObject({
      sourceId: "section:AGENTS.md",
      sourceName: "AGENTS.md",
    });

    for (const action of ttsrRules) {
      const cases = TTSR_CASES[action.sourceName];
      expect(cases).toBeDefined();
      expect(action.condition).toBeDefined();
      const regex = new RegExp(action.condition!, "i");
      for (const positive of cases.positives) {
        expect(regex.test(positive)).toBe(true);
      }
      for (const negative of cases.negatives) {
        expect(regex.test(negative)).toBe(false);
      }
    }

    const sourcePairs = [...plan.sources]
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .map((source) => `${source.sourceId}:${source.sourceHash}`)
      .join("\n");
    const expectedSourceSetHash = createHash("sha256").update(sourcePairs).digest("hex");
    expect(plan.sourceSetHash).toBe(expectedSourceSetHash);
  });

  test("source hashes and slugs are stable across repeated planning", () => {
    const skills = [
      skill("Verification", "Evidence before claims."),
      skill("Unknown Reference!", "Lookup-only content."),
    ];
    const sections = [section("AGENTS.md", "short repo instructions")];

    const prompt = `prompt for ${skills.map((s) => s.name).join(",")}`;
    const first = buildOptimizationPlan({ prompt, sections, skills, techStack: TYPESCRIPT_STACK });
    const second = buildOptimizationPlan({
      prompt,
      sections: [...sections].reverse(),
      skills: [...skills].reverse(),
      techStack: TYPESCRIPT_STACK,
    });

    expect(second).toEqual(first);
    expect(hashOptimizationSource("same source")).toBe(hashOptimizationSource("same source"));
    expect(hashOptimizationSource("same source")).not.toBe(hashOptimizationSource("other source"));
    expect(slugifyOptimizationSource("Skill: Unknown Reference!")).toBe("skill-unknown-reference");
  });
});


describe("buildOptimizationPlan accounting", () => {
  test("beforeBytes equals the original prompt size, ignoring overlap between sections and skills", () => {
    const debugging = skill("debugging", "Systematic debugging methodology.");
    const dbRef = skill("database-reference", "Occasional lookup material.");
    const skills = [debugging, dbRef];
    // Section content overlaps with skill content (the # Skills block is inside it).
    const sections = [
      section(
        "Base system prompt",
        `You are an OMP agent.\n# Skills\n${debugging.content}\n${dbRef.content}`,
      ),
    ];
    const prompt = `You are an OMP agent.\n# Skills\n${debugging.content}\n${dbRef.content}`;

    const plan = buildOptimizationPlan({
      prompt,
      sections,
      skills,
      techStack: TYPESCRIPT_STACK,
    });

    expect(plan.beforeBytes).toBe(bytes(prompt));
  });

  test("estimatedSavedBytes counts both write-rule and tech-stack manual-disable sources, deduplicated", () => {
    const debugging = skill("debugging", "Systematic debugging methodology.");
    const shadcn = skill("shadcn-ui", "React component reference.");
    const dbRef = skill("database-reference", "Occasional lookup material.");
    const skills = [debugging, shadcn, dbRef];
    const sections: PromptSection[] = [];
    const prompt = skills.map((s) => s.content).join("\n");

    const plan = buildOptimizationPlan({
      prompt,
      sections,
      skills,
      techStack: TYPESCRIPT_STACK,
    });

    const expectedSavedBytes = plan.sources
      .filter((source) => source.sourceType === "skill")
      .reduce((sum, source) => sum + source.bytes, 0);

    expect(plan.estimatedSavedBytes).toBe(expectedSavedBytes);
    expect(plan.estimatedAfterBytes).toBe(Math.max(0, plan.beforeBytes - plan.estimatedSavedBytes));
  });
});