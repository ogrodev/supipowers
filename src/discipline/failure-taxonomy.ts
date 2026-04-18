/**
 * Workflow failure taxonomy.
 *
 * Small, explicit set of failure classes used by summarizer and eval-promotion
 * to turn raw reliability records + session notes into actionable categories.
 *
 * Classification is pure: regex / string checks only, no dynamic evaluation,
 * deterministic for the same input, never throws.
 */

export const FAILURE_CLASSES = [
	"premature-completion",
	"wrong-tool-path",
	"missing-artifact",
	"verification-skipped",
	"discovery-miss",
	"unproductive-retry",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface FailureSignals {
	/** Stored reliability record, optional. */
	outcome?: "ok" | "blocked" | "retry-exhausted" | "fallback" | "agent-error";
	/** Reason string from the reliability record or log, optional. */
	reason?: string;
	/** Tool call name if the failure involves a blocked/rerouted tool. */
	toolName?: string;
	/** Path of an artifact that was expected but not found. */
	missingArtifactPath?: string;
	/** Free-text description from debug traces or session notes. */
	note?: string;
	/** Attempt count from the reliability record, optional. */
	attempts?: number;
}

const BLOCKED_TOOLS = new Set<string>([
	"grep",
	"bash-grep",
	"bash-find",
	"curl",
	"wget",
	"fetch",
	"WebFetch",
]);

const DESCRIPTIONS: Record<FailureClass, string> = {
	"premature-completion":
		"Workflow claimed done before required artifact existed.",
	"wrong-tool-path":
		"Workflow reached for a blocked tool instead of the preferred ctx_* tool.",
	"missing-artifact":
		"Required output (plan file, session, findings.md) was never written.",
	"verification-skipped":
		"Agent skipped a mandatory verification step (test, typecheck, eval).",
	"discovery-miss":
		"Workflow wandered before finding the right entry point.",
	"unproductive-retry":
		"Retry loop spent attempts without making progress.",
};

/**
 * Classify a failure based on signals. Returns one or more matching classes in
 * priority order (matching `FAILURE_CLASSES` order); empty array when no class
 * fires. Deterministic — never throws.
 */
export function classifyFailure(signals: FailureSignals): FailureClass[] {
	const reason = signals.reason ?? "";
	const note = signals.note ?? "";
	const matches: FailureClass[] = [];

	// premature-completion
	if (
		(signals.outcome === "ok" &&
			/incomplete|partial|unresolved/i.test(reason)) ||
		(signals.outcome === "fallback" &&
			/never produced valid artifact/i.test(reason))
	) {
		matches.push("premature-completion");
	}

	// wrong-tool-path
	if (
		(signals.toolName && BLOCKED_TOOLS.has(signals.toolName)) ||
		/ctx_/.test(reason)
	) {
		matches.push("wrong-tool-path");
	}

	// missing-artifact
	if (
		signals.missingArtifactPath !== undefined ||
		(/missing/i.test(reason) && /plan|findings|session/i.test(reason))
	) {
		matches.push("missing-artifact");
	}

	// verification-skipped
	if (
		/without running (validator|tests|typecheck)/i.test(reason) ||
		/skipped (verification|validation|test)/i.test(reason)
	) {
		matches.push("verification-skipped");
	}

	// discovery-miss
	if (
		/wandered/i.test(reason) ||
		/wrong file/i.test(reason) ||
		/searched broadly/i.test(note)
	) {
		matches.push("discovery-miss");
	}

	// unproductive-retry
	if (signals.outcome === "retry-exhausted" && (signals.attempts ?? 0) >= 3) {
		matches.push("unproductive-retry");
	}

	return matches;
}

/** Canonical human-friendly description per class. */
export function describeFailureClass(cls: FailureClass): string {
	return DESCRIPTIONS[cls];
}
