import * as fs from "node:fs";
import * as path from "node:path";
import { applyModelOverride } from "../config/model-resolver.js";
import type { Platform, PlatformPaths } from "../platform/types.js";
import type { Manifest, ManifestStatus, UiDesignSession } from "./types.js";

/**
 * Session-lifecycle state for `/supi:ui-design`.
 *
 * Mirrors the planning approval-flow pattern: one active session at a time,
 * tracked via module-level state; swapped cleanly on new invocations; cleaned
 * up by the `agent_end` hook when the director terminates.
 */

let activeSession: UiDesignSession | null = null;
let activeCleanup: (() => Promise<void>) | null = null;

const MANIFEST_STATUSES = new Set<ManifestStatus>([
  "in-progress",
  "critiquing",
  "awaiting-review",
  "complete",
  "discarded",
]);
const COMPLETION_PROOF_FILE = "completion-proof.json";
const REVIEW_APPROVAL_FILE = "review-approval.json";
const PATH_URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

type UiDesignReviewDecision = "approve" | "request-changes" | "discard";

interface UiDesignReviewApprovalRecord {
  question: string;
  options: string[];
  selected: UiDesignReviewDecision;
  selectedLabel: string;
  recordedAt: string;
}

interface CompletionProof {
  valid: boolean;
  validatedAt: string;
  issues: string[];
  page: string;
  critiquePath: string;
  reviewPath: string;
  approvalRecordPath: string;
  approvalDecision: UiDesignReviewDecision | null;
  critique: NonNullable<Manifest["critique"]>;
}

const RESUME_STEER_TEMPLATE = (sessionDir: string): string =>
  [
    "Continue the /supi:ui-design run.",
    `Read \`${path.join(sessionDir, "manifest.json")}\` and \`${path.join(sessionDir, "decomposition.json")}\` for state;`,
    "resume the first phase whose precondition output is missing.",
  ].join(" ");

const REPAIR_COMPLETE_STEER_TEMPLATE = (sessionDir: string, completionIssues: string[]): string =>
  [
    "Continue the /supi:ui-design run.",
    `The manifest at \`${path.join(sessionDir, "manifest.json")}\` claims \`status: \"complete\"\` but completion validation failed: ${completionIssues.join(", ")}.`,
    `Read \`${path.join(sessionDir, "manifest.json")}\`, \`${path.join(sessionDir, "page.html")}\`, \`${path.join(sessionDir, "critique.md")}\`, and \`${path.join(sessionDir, "screen-review.html")}\` if present, then resume the first incomplete review/finalization phase and rewrite the manifest truthfully.`,
  ].join(" ");

export function generateUiDesignSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `uidesign-${date}-${time}-${suffix}`;
}

export function createSessionDir(paths: PlatformPaths, cwd: string, sessionId: string): string {
  const dir = paths.project(cwd, "ui-design", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function startUiDesignTracking(
  session: UiDesignSession,
  cleanup: () => Promise<void>,
): void {
  // Swap: run previous cleanup, never block startup on its resolution.
  const previousCleanup = activeCleanup;
  activeSession = session;
  activeCleanup = cleanup;
  if (previousCleanup) {
    // Fire-and-forget: we already replaced the active references, so a
    // failing previous cleanup cannot leak state into the new session.
    previousCleanup().catch(() => {});
  }
}

export function cancelUiDesignTracking(_reason: string): void {
  activeSession = null;
  activeCleanup = null;
}

export function isUiDesignActive(): boolean {
  return activeSession !== null;
}

export function getActiveUiDesignSession(): UiDesignSession | null {
  return activeSession;
}

/**
 * Idempotent cleanup used from session_start / session_shutdown hooks.
 * Runs the active cleanup (if any) and clears tracking state.
 */
export async function stopActiveUiDesignSession(): Promise<void> {
  await runCleanup();
  activeSession = null;
  activeCleanup = null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCritiqueSummary(value: unknown): value is NonNullable<Manifest["critique"]> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.fixableCount === "number" &&
    typeof record.advisoryCount === "number" &&
    typeof record.fixIterations === "number"
  );
}

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.backend === "string" &&
    typeof record.status === "string" &&
    MANIFEST_STATUSES.has(record.status as ManifestStatus) &&
    typeof record.acknowledged === "boolean" &&
    typeof record.createdAt === "string" &&
    typeof record.page === "string" &&
    isStringArray(record.components) &&
    isStringArray(record.sections) &&
    (record.scope === undefined || record.scope === "page" || record.scope === "flow" || record.scope === "component") &&
    (record.topic === undefined || typeof record.topic === "string") &&
    (record.approvedAt === undefined || typeof record.approvedAt === "string") &&
    (record.critique === undefined || isCritiqueSummary(record.critique))
  );
}

function readManifest(sessionDir: string): Manifest | null {
  const manifestPath = path.join(sessionDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePathWithinDir(
  rootDir: string,
  candidatePath: string,
  baseDirs: string[] = [rootDir],
): string | null {
  if (candidatePath.trim().length === 0 || PATH_URI_RE.test(candidatePath)) {
    return null;
  }

  const root = path.resolve(rootDir);
  for (const baseDir of baseDirs) {
    const resolved = path.resolve(baseDir, candidatePath);
    const relative = path.relative(root, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return resolved;
    }
  }

  return null;
}

function resolveSessionArtifactPath(sessionDir: string, relativePath: string): string | null {
  return resolvePathWithinDir(sessionDir, relativePath);
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function looksLikeHtmlDocument(html: string): boolean {
  const normalized = html.toLowerCase();
  return (
    normalized.includes("<html") &&
    normalized.includes("</html>") &&
    normalized.includes("<body") &&
    normalized.includes("</body>")
  );
}

function validateHtmlArtifact(filePath: string, label: string, issues: string[]): void {
  const html = readTextFile(filePath);
  if (html === null) {
    issues.push(`${label} unreadable`);
    return;
  }
  if (!looksLikeHtmlDocument(html)) {
    issues.push(`${label} is not a full HTML document`);
  }
}

function normalizeReviewDecision(label: string): UiDesignReviewDecision | null {
  const normalized = label.trim().toLowerCase().replace(/[^a-z]+/g, "");
  switch (normalized) {
    case "approve":
    case "approved":
      return "approve";
    case "requestchanges":
    case "requestchange":
      return "request-changes";
    case "discard":
    case "discarded":
      return "discard";
    default:
      return null;
  }
}

function hasReviewDecisionSet(options: string[]): boolean {
  const decisions = new Set(
    options
      .map((option) => normalizeReviewDecision(option))
      .filter((decision): decision is UiDesignReviewDecision => decision !== null),
  );
  return (
    decisions.has("approve") &&
    decisions.has("request-changes") &&
    decisions.has("discard")
  );
}

function isReviewApprovalRecord(value: unknown): value is UiDesignReviewApprovalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.question === "string" &&
    isStringArray(record.options) &&
    (record.selected === "approve" ||
      record.selected === "request-changes" ||
      record.selected === "discard") &&
    typeof record.selectedLabel === "string" &&
    typeof record.recordedAt === "string"
  );
}

export function recordUiDesignReviewApproval(
  question: string,
  options: string[],
  selectedLabel: string,
): void {
  const session = activeSession;
  if (!session) return;

  const selected = normalizeReviewDecision(selectedLabel);
  if (!selected || !hasReviewDecisionSet(options)) return;
  if (!fs.existsSync(path.join(session.dir, "screen-review.html"))) return;

  const record: UiDesignReviewApprovalRecord = {
    question,
    options: [...options],
    selected,
    selectedLabel,
    recordedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(
      path.join(session.dir, REVIEW_APPROVAL_FILE),
      JSON.stringify(record, null, 2),
    );
  } catch {
    // Non-fatal: completion validation will surface the missing audit artifact.
  }
}

function readReviewApprovalRecord(sessionDir: string): UiDesignReviewApprovalRecord | null {
  const approvalPath = path.join(sessionDir, REVIEW_APPROVAL_FILE);
  if (!fs.existsSync(approvalPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(approvalPath, "utf-8"));
    return isReviewApprovalRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function requireSessionArtifact(
  sessionDir: string,
  relativePath: string,
  issues: string[],
): string | null {
  const resolved = resolveSessionArtifactPath(sessionDir, relativePath);
  if (!resolved) {
    issues.push(`${relativePath} escapes the session dir`);
    return null;
  }
  if (!fs.existsSync(resolved)) {
    issues.push(relativePath);
    return null;
  }
  return resolved;
}

function validateTextArtifact(filePath: string, label: string, issues: string[]): void {
  const text = readTextFile(filePath);
  if (text === null) {
    issues.push(`${label} unreadable`);
    return;
  }
  if (text.trim().length === 0) {
    issues.push(`${label} is empty`);
  }
}

function validateJsonArtifact(filePath: string, label: string, issues: string[]): void {
  const text = readTextFile(filePath);
  if (text === null) {
    issues.push(`${label} unreadable`);
    return;
  }

  try {
    JSON.parse(text);
  } catch {
    issues.push(`${label} is not valid JSON`);
  }
}

function validateSessionTextArtifact(
  sessionDir: string,
  relativePath: string,
  issues: string[],
): void {
  const filePath = requireSessionArtifact(sessionDir, relativePath, issues);
  if (!filePath) return;
  validateTextArtifact(filePath, relativePath, issues);
}

function validateSessionHtmlArtifact(
  sessionDir: string,
  relativePath: string,
  issues: string[],
): void {
  const filePath = requireSessionArtifact(sessionDir, relativePath, issues);
  if (!filePath) return;
  validateHtmlArtifact(filePath, relativePath, issues);
}

function validateSessionJsonArtifact(
  sessionDir: string,
  relativePath: string,
  issues: string[],
): void {
  const filePath = requireSessionArtifact(sessionDir, relativePath, issues);
  if (!filePath) return;
  validateJsonArtifact(filePath, relativePath, issues);
}

function validateTrackedComponentArtifacts(
  sessionDir: string,
  manifest: Manifest,
  issues: string[],
): void {
  for (const component of manifest.components) {
    validateSessionTextArtifact(sessionDir, path.join("components", `${component}.html`), issues);
    validateSessionJsonArtifact(
      sessionDir,
      path.join("components", `${component}.tokens.json`),
      issues,
    );
  }

  for (const section of manifest.sections) {
    validateSessionTextArtifact(sessionDir, path.join("sections", `${section}.html`), issues);
  }
}

function extractMarkdownSection(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const target = `## ${heading}`.toLowerCase();
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === target);
  if (startIndex === -1) return null;

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) break;
    sectionLines.push(line);
  }

  return sectionLines.join("\n").trim();
}

function countCritiqueItems(section: string, label: string, issues: string[]): number {
  const lines = section
    .split(/\r?\n/)
.map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    issues.push(`critique.md ${label} section is empty`);
    return 0;
  }

  if (lines.every((line) => /^(?:[-*+]\s+)?(?:none|n\/a)$/i.test(line))) {
    return 0;
  }

  const bulletLines = lines.filter((line) => /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line));
  if (bulletLines.length !== lines.length) {
    issues.push(`critique.md ${label} section must be a bullet list or 'none'`);
  }
  return bulletLines.length;
}

function parseCritiqueSummary(markdown: string, issues: string[]): { fixableCount: number; advisoryCount: number } {
  const fixableSection = extractMarkdownSection(markdown, "Fixable");
  const advisorySection = extractMarkdownSection(markdown, "Advisory");

  if (!fixableSection) {
    issues.push("critique.md missing `## Fixable` section");
  }
  if (!advisorySection) {
    issues.push("critique.md missing `## Advisory` section");
  }

  const fixableCount = fixableSection ? countCritiqueItems(fixableSection, "Fixable", issues) : 0;
  const advisoryCount = advisorySection ? countCritiqueItems(advisorySection, "Advisory", issues) : 0;

  if (fixableCount > 0) {
    issues.push(`critique.md lists ${fixableCount} unresolved fixable item(s)`);
  }

  return { fixableCount, advisoryCount };
}

function writeCompletionProof(sessionDir: string, proof: CompletionProof): void {
  try {
    fs.writeFileSync(
      path.join(sessionDir, COMPLETION_PROOF_FILE),
      JSON.stringify(proof, null, 2),
    );
  } catch {
    // non-fatal: validation still gates completion in-memory
  }
}

function sameCritiqueSummary(
  left: Manifest["critique"] | undefined,
  right: Manifest["critique"] | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.fixableCount === right.fixableCount &&
    left.advisoryCount === right.advisoryCount &&
    left.fixIterations === right.fixIterations
  );
}

function validateCompletionProof(
  sessionDir: string,
  manifest: Manifest,
): { issues: string[]; validatedManifest: Manifest } {
  const issues: string[] = [];

  validateSessionTextArtifact(sessionDir, "context.md", issues);
  validateSessionHtmlArtifact(sessionDir, "screen-decomposition.html", issues);
  validateSessionJsonArtifact(sessionDir, "decomposition.json", issues);

  const pagePath = resolveSessionArtifactPath(sessionDir, manifest.page);
  if (!pagePath) {
    issues.push(`${manifest.page || "page.html"} escapes the session dir`);
  } else if (!fs.existsSync(pagePath)) {
    issues.push(manifest.page || "page.html");
  } else {
    validateHtmlArtifact(pagePath, manifest.page, issues);
  }

  validateTrackedComponentArtifacts(sessionDir, manifest, issues);

  const critiquePath = path.join(sessionDir, "critique.md");
  let critique = {
    fixableCount: manifest.critique?.fixableCount ?? 0,
    advisoryCount: manifest.critique?.advisoryCount ?? 0,
  };
  if (!fs.existsSync(critiquePath)) {
    issues.push("critique.md");
  } else {
    const critiqueContent = readTextFile(critiquePath);
    if (critiqueContent === null) {
      issues.push("critique.md unreadable");
    } else {
      critique = parseCritiqueSummary(critiqueContent, issues);
    }
  }

  validateSessionHtmlArtifact(sessionDir, "screen-review.html", issues);

  const approval = readReviewApprovalRecord(sessionDir);
  if (!approval) {
    issues.push(REVIEW_APPROVAL_FILE);
  } else if (approval.selected !== "approve") {
    issues.push(`${REVIEW_APPROVAL_FILE} selected ${approval.selected}`);
  }

  const critiqueSummary = {
    fixableCount: critique.fixableCount,
    advisoryCount: critique.advisoryCount,
    fixIterations: manifest.critique?.fixIterations ?? 0,
  };
  const validatedManifest: Manifest = {
    ...manifest,
    approvedAt: approval?.selected === "approve" ? approval.recordedAt : manifest.approvedAt,
    critique: critiqueSummary,
  };

  writeCompletionProof(sessionDir, {
    valid: issues.length === 0,
    validatedAt: new Date().toISOString(),
    issues: [...issues],
    page: manifest.page,
    critiquePath: "critique.md",
    reviewPath: "screen-review.html",
    approvalRecordPath: REVIEW_APPROVAL_FILE,
    approvalDecision: approval?.selected ?? null,
    critique: critiqueSummary,
  });

  return { issues, validatedManifest };
}

function writeManifest(sessionDir: string, manifest: Manifest): void {
  fs.writeFileSync(
    path.join(sessionDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

async function runCleanup(): Promise<void> {
  const cleanup = activeCleanup;
  if (!cleanup) return;
  try {
    await cleanup();
  } catch {
    // swallow — never block agent_end
  }
}

async function resumeSession(
  platform: Platform,
  ctx: any,
  session: UiDesignSession,
  steerMessage: string,
): Promise<void> {
  if (session.resolvedModel) {
    await applyModelOverride(platform, ctx, "ui-design", session.resolvedModel);
  }
  platform.sendMessage(
    {
      customType: "supi-ui-design-resume",
      content: [{ type: "text", text: steerMessage }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function discardSessionDir(sessionDir: string): void {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // ignore — user can clean up manually
  }
}

function getUiDesignWritePath(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case "write":
    case "edit":
    case "ast_edit":
      return typeof input.path === "string" ? input.path : "";
    case "notebook":
      return typeof input.notebook_path === "string" ? input.notebook_path : "";
    default:
      return undefined;
  }
}

export function registerUiDesignToolGuard(platform: Platform): void {
  platform.on("tool_call", (event: any) => {
    const session = activeSession;
    if (!session) return;

    if (event.toolName === "exit_plan_mode") {
      return {
        block: true,
        reason: "UI-design mode: completion is driven by the agent_end approval hook; do not call exit_plan_mode.",
      };
    }

    if (event.toolName === "bash") {
      return {
        block: true,
        reason: `UI-design mode: bash is not allowed. Write artifacts with write/edit inside \`${session.dir}\` and use task for delegated work.`,
      };
    }

    const candidatePath = getUiDesignWritePath(
      event.toolName,
      (event.input ?? {}) as Record<string, unknown>,
    );
    if (candidatePath === undefined) return;
    if (candidatePath.length === 0) {
      return {
        block: true,
        reason: `UI-design mode: cannot verify ${event.toolName} without a path under \`${session.dir}\`.`,
      };
    }

    if (!resolvePathWithinDir(session.dir, candidatePath, [session.dir, process.cwd()])) {
      return {
        block: true,
        reason: `UI-design mode: ${event.toolName} may only write inside \`${session.dir}\`.`,
      };
    }
  });
}

/**
 * Register the `agent_end` hook that drives the ui-design approval UI.
 *
 * Terminal statuses (`complete`, `discarded`, missing-manifest) tear down the
 * companion and cancel tracking. Resume statuses (`in-progress`, `critiquing`,
 * `awaiting-review`) offer the user a choice: resume the session or discard.
 * On resume we send a steer message and keep tracking active.
 */
export function registerUiDesignApprovalHook(platform: Platform): void {
  platform.on("agent_end", async (_event: any, ctx: any) => {
    const session = activeSession;
    if (!session || !ctx?.hasUI) return;

    const sessionDir = session.dir;
    const manifest = readManifest(sessionDir);

    // Missing / unparseable manifest — unsafe to resume
    if (!manifest) {
      const choice = await ctx.ui.select(
        "ui-design session is in an unknown state — what next?",
        ["Discard session"],
      );
      if (choice) {
        await runCleanup();
        discardSessionDir(sessionDir);
      }
      cancelUiDesignTracking("manifest_missing");
      return;
    }

    if (manifest.status === "complete") {
      const completion = validateCompletionProof(sessionDir, manifest);
      const validatedManifest = completion.validatedManifest;
      if (
        !sameCritiqueSummary(manifest.critique, validatedManifest.critique) ||
        manifest.approvedAt !== validatedManifest.approvedAt
      ) {
        writeManifest(sessionDir, validatedManifest);
      }

      if (completion.issues.length > 0) {
        const choice = await ctx.ui.select(
          `ui-design session claims completion but validation failed (${completion.issues.join(", ")}) — what next?`,
          ["Resume session", "Discard session"],
        );
        if (choice === "Resume session") {
          await resumeSession(
            platform,
            ctx,
            session,
            REPAIR_COMPLETE_STEER_TEMPLATE(sessionDir, completion.issues),
          );
          return;
        }
        if (choice === "Discard session") {
          await runCleanup();
          discardSessionDir(sessionDir);
          cancelUiDesignTracking("invalid_complete_discarded");
          return;
        }
        return;
      }

      if (validatedManifest.acknowledged) return;
      const choice = await ctx.ui.select(
        "Design complete — what next?",
        ["Keep artifacts and exit", "Open session dir", "Discard session"],
      );
      if (choice === "Keep artifacts and exit") {
        writeManifest(sessionDir, { ...validatedManifest, acknowledged: true });
        await runCleanup();
      } else if (choice === "Discard session") {
        await runCleanup();
        discardSessionDir(sessionDir);
      } else if (choice === "Open session dir") {
        writeManifest(sessionDir, { ...validatedManifest, acknowledged: true });
        await runCleanup();
        try {
          await platform.exec("open", [sessionDir]);
        } catch {
          // non-fatal
        }
      }
      cancelUiDesignTracking("complete");
      return;
    }

    if (manifest.status === "discarded") {
      await runCleanup();
      discardSessionDir(sessionDir);
      cancelUiDesignTracking("discarded");
      return;
    }

    // Resume-eligible statuses
    if (
      manifest.status === "in-progress" ||
      manifest.status === "critiquing" ||
      manifest.status === "awaiting-review"
    ) {
      const choice = await ctx.ui.select(
        `ui-design session paused (${manifest.status}) — what next?`,
        ["Resume session", "Discard session"],
      );
      if (choice === "Resume session") {
        await resumeSession(platform, ctx, session, RESUME_STEER_TEMPLATE(sessionDir));
        return;
      }
      if (choice === "Discard session") {
        await runCleanup();
        discardSessionDir(sessionDir);
        cancelUiDesignTracking("user_discard");
        return;
      }
      // Cancelled prompt — leave state as-is
      return;
    }
  });
}