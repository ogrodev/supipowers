import { describe, expect, test } from "bun:test";
import {
	FAILURE_CLASSES,
	type FailureClass,
	classifyFailure,
	describeFailureClass,
} from "../../src/discipline/failure-taxonomy";

describe("FAILURE_CLASSES", () => {
	test("contains exactly 6 entries in canonical order", () => {
		expect(FAILURE_CLASSES).toEqual([
			"premature-completion",
			"wrong-tool-path",
			"missing-artifact",
			"verification-skipped",
			"discovery-miss",
			"unproductive-retry",
		]);
		expect(FAILURE_CLASSES.length).toBe(6);
	});
});

describe("classifyFailure", () => {
	test("fires premature-completion on ok outcome with incomplete reason", () => {
		expect(
			classifyFailure({
				outcome: "ok",
				reason: "marked done but output was partial",
			}),
		).toEqual(["premature-completion"]);
	});

	test("fires premature-completion on fallback with never-produced-artifact reason", () => {
		expect(
			classifyFailure({
				outcome: "fallback",
				reason: "validator never produced valid artifact after 3 attempts",
			}),
		).toEqual(["premature-completion"]);
	});

	test("fires wrong-tool-path on blocked tool name", () => {
		expect(classifyFailure({ toolName: "grep" })).toEqual(["wrong-tool-path"]);
		expect(classifyFailure({ toolName: "WebFetch" })).toEqual([
			"wrong-tool-path",
		]);
	});

	test("fires wrong-tool-path when reason mentions ctx_", () => {
		expect(
			classifyFailure({
				reason: "should have routed through ctx_batch_execute",
			}),
		).toEqual(["wrong-tool-path"]);
	});

	test("fires missing-artifact when missingArtifactPath is set", () => {
		expect(
			classifyFailure({ missingArtifactPath: "local://PLAN.md" }),
		).toEqual(["missing-artifact"]);
	});

	test("fires missing-artifact when reason matches missing + artifact keyword", () => {
		expect(
			classifyFailure({ reason: "plan file was missing on disk" }),
		).toEqual(["missing-artifact"]);
	});

	test("fires verification-skipped when reason says agent skipped tests", () => {
		expect(
			classifyFailure({ reason: "agent skipped verification before yielding" }),
		).toEqual(["verification-skipped"]);
	});

	test("fires verification-skipped when reason mentions without running validator", () => {
		expect(
			classifyFailure({
				reason: "closed ticket without running validator",
			}),
		).toEqual(["verification-skipped"]);
	});

	test("fires discovery-miss on wandered / wrong file / searched broadly", () => {
		expect(classifyFailure({ reason: "agent wandered across modules" })).toEqual([
			"discovery-miss",
		]);
		expect(classifyFailure({ reason: "edited the wrong file twice" })).toEqual([
			"discovery-miss",
		]);
		expect(
			classifyFailure({ note: "subagent searched broadly before acting" }),
		).toEqual(["discovery-miss"]);
	});

	test("fires unproductive-retry on retry-exhausted with attempts >= 3", () => {
		expect(
			classifyFailure({ outcome: "retry-exhausted", attempts: 3 }),
		).toEqual(["unproductive-retry"]);
		expect(
			classifyFailure({ outcome: "retry-exhausted", attempts: 5 }),
		).toEqual(["unproductive-retry"]);
	});

	test("does not fire unproductive-retry below threshold", () => {
		expect(
			classifyFailure({ outcome: "retry-exhausted", attempts: 2 }),
		).toEqual([]);
	});

	test("returns empty when signals match no class", () => {
		expect(classifyFailure({})).toEqual([]);
		expect(
			classifyFailure({ outcome: "ok", reason: "everything fine" }),
		).toEqual([]);
	});

	test("reports multiple classes when multiple signals fire", () => {
		const result = classifyFailure({
			toolName: "curl",
			missingArtifactPath: ".omp/supipowers/findings.md",
		});
		expect(result).toContain("wrong-tool-path");
		expect(result).toContain("missing-artifact");
		// order follows FAILURE_CLASSES priority
		expect(result.indexOf("wrong-tool-path")).toBeLessThan(
			result.indexOf("missing-artifact"),
		);
	});

	test("is deterministic and does not throw on empty / odd input", () => {
		expect(() => classifyFailure({})).not.toThrow();
		expect(() =>
			classifyFailure({
				reason: "",
				note: "",
				toolName: "",
			}),
		).not.toThrow();
		const a = classifyFailure({
			outcome: "fallback",
			reason: "never produced valid artifact",
		});
		const b = classifyFailure({
			outcome: "fallback",
			reason: "never produced valid artifact",
		});
		expect(a).toEqual(b);
	});
});

describe("describeFailureClass", () => {
	test("returns a non-empty string for every class", () => {
		for (const cls of FAILURE_CLASSES) {
			const desc = describeFailureClass(cls satisfies FailureClass);
			expect(typeof desc).toBe("string");
			expect(desc.length).toBeGreaterThan(0);
		}
	});
});
