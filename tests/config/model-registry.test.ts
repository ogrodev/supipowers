
import { ModelActionRegistry } from "../../src/config/model-registry.js";
import type { ModelAction } from "../../src/types.js";

describe("ModelActionRegistry", () => {
  let registry: ModelActionRegistry;

  beforeEach(() => {
    registry = new ModelActionRegistry();
  });

  test("register and get an action", () => {
    const action: ModelAction = {
      id: "plan",
      category: "command",
      label: "Plan",
      harnessRoleHint: "plan",
    };
    registry.register(action);
    expect(registry.get("plan")).toEqual(action);
  });

  test("get returns undefined for unregistered action", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("register throws on duplicate id", () => {
    const action: ModelAction = { id: "plan", category: "command", label: "Plan" };
    registry.register(action);
    expect(() => registry.register(action)).toThrow("already registered");
  });

  test("list returns commands first, then sub-agents grouped by parent", () => {
    registry.register({ id: "plan", category: "command", label: "Plan" });
    registry.register({ id: "run", category: "command", label: "Run" });
    registry.register({ id: "implementer", category: "sub-agent", parent: "run", label: "Implementer" });
    registry.register({ id: "spec-reviewer", category: "sub-agent", parent: "run", label: "Spec Reviewer" });
    registry.register({ id: "review", category: "command", label: "Review" });

    const list = registry.list();
    const ids = list.map((a) => a.id);

    // Commands come first (alphabetical), then sub-agents grouped by parent
    expect(ids.indexOf("plan")).toBeLessThan(ids.indexOf("implementer"));
    expect(ids.indexOf("run")).toBeLessThan(ids.indexOf("implementer"));
    expect(ids.indexOf("review")).toBeLessThan(ids.indexOf("implementer"));
    // Sub-agents of same parent are together
    expect(Math.abs(ids.indexOf("implementer") - ids.indexOf("spec-reviewer"))).toBe(1);
  });

  test("listByCategory filters correctly", () => {
    registry.register({ id: "plan", category: "command", label: "Plan" });
    registry.register({ id: "implementer", category: "sub-agent", parent: "run", label: "Implementer" });

    expect(registry.listByCategory("command")).toHaveLength(1);
    expect(registry.listByCategory("command")[0].id).toBe("plan");
    expect(registry.listByCategory("sub-agent")).toHaveLength(1);
    expect(registry.listByCategory("sub-agent")[0].id).toBe("implementer");
  });

  test("harnessRoleHint defaults to undefined when omitted", () => {
    registry.register({ id: "plan", category: "command", label: "Plan" });
    const action = registry.get("plan");
    expect(action?.harnessRoleHint).toBeUndefined();
  });
});
