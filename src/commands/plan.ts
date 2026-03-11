import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/loader.js";
import { savePlan } from "../storage/plans.js";
import { notifySuccess, notifyInfo } from "../notifications/renderer.js";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerPlanCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:plan", {
    description: "Start collaborative planning for a feature or task",
    async handler(args, ctx) {
      const config = loadConfig(ctx.cwd);

      const skillPath = findSkillPath("planning");
      let skillContent = "";
      if (skillPath) {
        try {
          skillContent = fs.readFileSync(skillPath, "utf-8");
        } catch {
          // Skill file not found — proceed without it
        }
      }

      const isQuick = args?.startsWith("--quick");
      const quickDesc = isQuick ? args.replace("--quick", "").trim() : "";

      let prompt: string;
      if (isQuick && quickDesc) {
        prompt = [
          "Generate a concise implementation plan for the following task.",
          "Skip brainstorming — go straight to task breakdown.",
          "",
          `Task: ${quickDesc}`,
          "",
          "Format the plan as markdown with YAML frontmatter (name, created, tags).",
          "Each task should have: name, [parallel-safe] or [sequential] annotation,",
          "**files**, **criteria**, and **complexity** (small/medium/large).",
          "",
          skillContent ? "Follow these planning guidelines:\n" + skillContent : "",
          "",
          "After generating the plan, save it and confirm with the user.",
        ].join("\n");
      } else {
        prompt = [
          "You are starting a collaborative planning session with the user.",
          "",
          args ? `The user wants to plan: ${args}` : "Ask the user what they want to build or accomplish.",
          "",
          "Process:",
          "1. Understand the goal — ask clarifying questions (one at a time)",
          "2. Propose 2-3 approaches with trade-offs",
          "3. Generate a task breakdown once aligned",
          "",
          "Format the final plan as markdown with YAML frontmatter (name, created, tags).",
          "Each task: name, [parallel-safe] or [sequential] annotation,",
          "**files**, **criteria**, **complexity** (small/medium/large).",
          "",
          skillContent ? "Follow these planning guidelines:\n" + skillContent : "",
        ].join("\n");
      }

      pi.sendMessage(
        {
          customType: "supi-plan-start",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer" }
      );

      notifyInfo(ctx, "Planning started", args ? `Topic: ${args}` : "Describe what you want to build");
    },
  });
}

function findSkillPath(skillName: string): string | null {
  const candidates = [
    path.join(process.cwd(), "skills", skillName, "SKILL.md"),
    path.join(__dirname, "..", "..", "skills", skillName, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
