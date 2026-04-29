import { describe, expect, test } from "bun:test";
import { lookupProcessor } from "../../../src/context-mode/processors/registry.js";

describe("context-mode processor registry", () => {
  test("unmatched bash command returns null", () => {
    expect(lookupProcessor("bash", { command: "echo hi" }, "hi")).toBeNull();
  });

  test("processors.enabled false bypasses lookup", () => {
    expect(
      lookupProcessor("bash", { command: "git status" }, "On branch main", {
        processors: { enabled: false, disable: [] },
      }),
    ).toBeNull();
  });

  test("disabled key is skipped without mutating later lookup state", () => {
    const processors = { enabled: true, disable: ["git" as const] };

    expect(
      lookupProcessor("bash", { command: "git status" }, "## main", {
        processors,
      }),
    ).toBeNull();
    expect(processors.disable).toEqual(["git"]);

    expect(lookupProcessor("bash", { command: "git status" }, "## main")?.key).toBe("git");
  });

  test.each([
    ["git status", "## main"],
    [" git diff -- src", "diff --git a/a.ts b/a.ts"],
    ["git log --oneline", "a1b2c3d message"],
    ["git show HEAD", "diff --git a/a.ts b/a.ts"],
    ["git branch --all", "* main"],
    ["git stash list", "stash@{0}: WIP on main"],
  ])("routes %s to git", (command, text) => {
    expect(lookupProcessor("bash", { command }, text)?.key).toBe("git");
  });

  test.each([
    ["bun test"],
    ["vitest"],
    ["jest"],
    ["npx vitest"],
    ["npx jest"],
  ])("routes %s to test", (command) => {
    expect(lookupProcessor("bash", { command }, "FAIL tests/example.test.ts")?.key).toBe("test");
  });

  test("routes JSON-shaped output from unmatched bash command to json", () => {
    const match = lookupProcessor("bash", { command: "node script.js" }, "{\"ok\":true}");
    expect(match?.key).toBe("json");
  });

  test("disabled JSON content sniff returns null", () => {
    const match = lookupProcessor("bash", { command: "node script.js" }, "{\"ok\":true}", {
      processors: { enabled: true, disable: ["json"] },
    });
    expect(match).toBeNull();
  });

  test.each([
    ["tail -f /var/log/app.log"],
    ["journalctl -u app"],
    ["less +F /var/log/app.log"],
  ])("routes %s to log", (command) => {
    const text = "2026-04-28T10:00:00Z INFO boot\n2026-04-28T10:00:01Z INFO ready";
    expect(lookupProcessor("bash", { command }, text)?.key).toBe("log");
  });

  test("routes timestamp-dense text without argv match to log", () => {
    const text = "2026-04-28T10:00:00Z INFO boot\n2026-04-28T10:00:01Z ERROR failed";
    expect(lookupProcessor("bash", { command: "node script.js" }, text)?.key).toBe("log");
  });

  test("json content sniff wins before log for ambiguous text", () => {
    const text = `[\n  "2026-04-28T10:00:00Z INFO boot",\n  "2026-04-28T10:00:01Z ERROR failed",\n  "2026-04-28T10:00:02Z INFO ready"\n]`;
    expect(lookupProcessor("bash", { command: "node script.js" }, text)?.key).toBe("json");
  });

  test.each([
    ["eslint ."],
    ["biome check ."],
    ["biome lint ."],
    ["prettier --check ."],
  ])("routes %s to lint", (command) => {
    expect(lookupProcessor("bash", { command }, "src/a.ts:1:7 error rule")?.key).toBe("lint");
  });

  test.each([
    ["tsc"],
    ["tsc -p tsconfig.json"],
    ["cargo build"],
    ["cargo check"],
    ["go build ./..."],
    ["esbuild src/index.ts"],
    ["next build"],
    ["bun run build"],
  ])("routes %s to build", (command) => {
    expect(lookupProcessor("bash", { command }, "src/a.ts(1,1): error TS1005")?.key).toBe("build");
  });

  test.each([
    ["kubectl get pods"],
    ["kubectl describe pod api-abc"],
    ["kubectl logs api-abc"],
    ["kubectl top pod"],
  ])("routes %s to k8s", (command) => {
    expect(lookupProcessor("bash", { command }, "NAMESPACE NAME STATUS")?.key).toBe("k8s");
  });

  test.each([
    ["docker ps"],
    ["docker images"],
    ["docker logs api-1"],
    ["docker inspect api-1"],
    ["docker build ."],
  ])("routes %s to docker", (command) => {
    expect(lookupProcessor("bash", { command }, "CONTAINER ID IMAGE STATUS")?.key).toBe("docker");
  });

  test("routes k8s and docker JSON output through json override", () => {
    expect(lookupProcessor("bash", { command: "kubectl get pods -o json" }, "{\"items\":[]}")?.key).toBe("json");
    expect(lookupProcessor("bash", { command: "docker inspect abc" }, "[{\"Id\":\"abc\"}]")?.key).toBe("json");
    expect(lookupProcessor("bash", { command: "kubectl get pods" }, "NAMESPACE NAME STATUS")?.key).toBe("k8s");
    expect(lookupProcessor("bash", { command: "docker inspect abc" }, "not json")?.key).toBe("docker");
  });
});
