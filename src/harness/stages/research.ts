/**
 * RESEARCH stage runner.
 *
 * Builds `<session>/research/<topic>.md` for every mandatory research topic. The plan
 * specifies these topics (§5 Phase 4):
 *
 *  - "AGENTS.md best practices"
 *  - "Layered architecture enforcement for <lang>" (capped at 3 languages; ≥3 → polyglot)
 *  - "Structural test patterns for <stack>"
 *  - "Eval frameworks for <stack>"
 *  - "Drift detection patterns"
 *  - "LLM-failure-mode taxonomy"
 *  - "Code-duplication detection tools"
 *  - "Dead-code detection per language"
 *  - "Pre-edit duplicate-probe ergonomics"
 *  - "Persistent execution-queue patterns"
 *
 * The runner emits a structured stub for each topic (mandatory headings + frontmatter)
 * the user / a downstream agent fills in. The validator (which lives in the command
 * handler) requires ≥2 primary-source URLs and the `## Options` + `## Recommendation`
 * sections; stubs only ship those headings, so a validation pass after Research
 * intentionally fails until a researcher completes them.
 *
 * Why deterministic stubs and not auto-fan-out? Two reasons:
 *  1. Web search results drift; we must not bake them in.
 *  2. The plan calls for parallel sub-agents. Spawning them properly requires the model
 *     resolution wired through model.json — which we do here, but the actual writeups
 *     are best authored manually for v1 to keep the dependency surface narrow. The agent
 *     entry point lives in command-handlers, not the stage runner.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
  nowIso,
} from "../stage-runner.js";
import {
  loadHarnessDiscover,
  saveHarnessResearchTopic,
} from "../storage.js";
import { getHarnessResearchDir } from "../project-paths.js";

const BASE_TOPICS: readonly string[] = [
  "agents-md-best-practices",
  "drift-detection-patterns",
  "llm-failure-mode-taxonomy",
  "code-duplication-detection-tools",
  "dead-code-detection-per-language",
  "pre-edit-duplicate-probe-ergonomics",
  "persistent-execution-queue-patterns",
];

const STACK_TOPICS_PREFIX = "layered-architecture-enforcement";
const STRUCTURAL_PREFIX = "structural-test-patterns";
const EVAL_PREFIX = "eval-frameworks";

const POLYGLOT_BUCKET_THRESHOLD = 3;
const TOPIC_CAP = 12;

export interface ResearchTopicPlan {
  slug: string;
  title: string;
  context: string;
}

/**
 * Compute the topic plan from the discover artifact's languages. Caps at TOPIC_CAP and
 * collapses to a polyglot bucket when ≥3 languages are present.
 */
export function buildResearchTopicPlan(input: { languages: readonly string[] }): ResearchTopicPlan[] {
  const languages = [...new Set(input.languages.map((l) => l.toLowerCase()))].filter((l) => l.length > 0);
  const topics: ResearchTopicPlan[] = [];

  for (const slug of BASE_TOPICS) {
    topics.push({
      slug,
      title: humanizeSlug(slug),
      context: "Always-on base topic (independent of stack).",
    });
  }

  if (languages.length >= POLYGLOT_BUCKET_THRESHOLD) {
    topics.push({
      slug: `${STACK_TOPICS_PREFIX}-polyglot`,
      title: "Layered architecture enforcement (polyglot)",
      context: `${languages.length} languages detected; collapsed into a single polyglot topic.`,
    });
    topics.push({
      slug: `${STRUCTURAL_PREFIX}-polyglot`,
      title: "Structural test patterns (polyglot)",
      context: "Multi-language repo; structural tests need to span every detected stack.",
    });
    topics.push({
      slug: `${EVAL_PREFIX}-polyglot`,
      title: "Eval frameworks (polyglot)",
      context: "Multi-language repo; eval suites must support multiple test runners.",
    });
  } else {
    for (const lang of languages.slice(0, 3)) {
      topics.push({
        slug: `${STACK_TOPICS_PREFIX}-${lang}`,
        title: `Layered architecture enforcement for ${lang}`,
        context: `${lang} detected as a primary language.`,
      });
    }
    const dominant = languages[0];
    if (dominant) {
      topics.push({
        slug: `${STRUCTURAL_PREFIX}-${dominant}`,
        title: `Structural test patterns for ${dominant}`,
        context: `${dominant} is the dominant language.`,
      });
      topics.push({
        slug: `${EVAL_PREFIX}-${dominant}`,
        title: `Eval frameworks for ${dominant}`,
        context: `${dominant} is the dominant language.`,
      });
    }
  }

  return topics.slice(0, TOPIC_CAP);
}

function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Render the markdown stub for a research topic. Always includes the mandatory `##
 * Options` and `## Recommendation` headings + a frontmatter block; sources start empty
 * (the validator demands ≥2 before Research is considered complete).
 */
export function renderResearchTopicStub(input: {
  topic: ResearchTopicPlan;
  recordedAt: string;
}): string {
  return [
    "---",
    `topic: ${input.topic.slug}`,
    `title: ${JSON.stringify(input.topic.title)}`,
    `lastVerified: ${input.recordedAt}`,
    "sources: []",
    "---",
    "",
    `# ${input.topic.title}`,
    "",
    `> ${input.topic.context}`,
    "",
    "## Background",
    "",
    "_Pending researcher writeup. Validator will fail until this section is filled in._",
    "",
    "## Options",
    "",
    "_List candidate approaches with tradeoffs._",
    "",
    "## Recommendation",
    "",
    "_State the recommended approach and the criteria that drove the choice._",
    "",
    "## Sources",
    "",
    "_Cite at least two primary sources (papers, official docs, RFCs). Validator rejects writeups with fewer._",
    "",
    "## Last verified",
    "",
    `${input.recordedAt}`,
    "",
  ].join("\n");
}

export class HarnessResearchStage implements HarnessStageRunner {
  readonly stage = "research" as const;

  async isReady(ctx: HarnessStageRunnerContext): Promise<boolean> {
    const discover = loadHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId);
    return discover.ok;
  }

  async isComplete(ctx: HarnessStageRunnerContext): Promise<boolean> {
    const dir = getHarnessResearchDir(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!fs.existsSync(dir)) return false;
    try {
      const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: ["research/"],
        details: { reason: "research/ already populated" },
      };
    }

    const discover = loadHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!discover.ok) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: {
          code: "discover-missing",
          message: "Research requires a completed Discover artifact",
        },
      };
    }

    const plan = buildResearchTopicPlan({ languages: discover.value.languages });
    const recordedAt = nowIso(ctx);
    const written: string[] = [];
    for (const topic of plan) {
      const stub = renderResearchTopicStub({ topic, recordedAt });
      const result = saveHarnessResearchTopic(ctx.paths, ctx.cwd, ctx.sessionId, topic.slug, stub);
      if (!result.ok) {
        return {
          status: "failed",
          stage: this.stage,
          artifactPaths: written,
          error: `failed to write research topic ${topic.slug}: ${result.error.message}`,
        };
      }
      written.push(path.posix.join("research", `${topic.slug}.md`));
    }

    return {
      status: "completed",
      stage: this.stage,
      artifactPaths: written,
      details: { topicCount: plan.length },
    };
  }
}

/**
 * Validate a research writeup. Returns an array of error messages (empty when valid).
 * Mirrors the plan's validator: ≥2 sources + presence of `## Options` and `##
 * Recommendation` headings.
 */
export function validateResearchTopic(markdown: string): string[] {
  const errors: string[] = [];
  if (!/^##\s+Options\b/im.test(markdown)) errors.push("missing `## Options` heading");
  if (!/^##\s+Recommendation\b/im.test(markdown)) errors.push("missing `## Recommendation` heading");

  // Sources: count distinct URLs in the doc body. We accept either a frontmatter
  // `sources: [...]` block or inline `https://` links anywhere.
  const urls = new Set<string>();
  for (const match of markdown.matchAll(/https?:\/\/[^\s)<>"']+/g)) {
    urls.add(match[0]);
  }
  if (urls.size < 2) errors.push(`requires ≥2 source URLs (found ${urls.size})`);

  return errors;
}
