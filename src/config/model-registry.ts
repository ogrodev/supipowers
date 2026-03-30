import type { ModelAction, ModelActionCategory } from "../types.js";

export class ModelActionRegistry {
  private actions = new Map<string, ModelAction>();

  register(action: ModelAction): void {
    if (this.actions.has(action.id)) {
      throw new Error(`Model action "${action.id}" is already registered`);
    }
    this.actions.set(action.id, action);
  }

  get(id: string): ModelAction | undefined {
    return this.actions.get(id);
  }

  list(): ModelAction[] {
    const commands: ModelAction[] = [];
    const subAgentsByParent = new Map<string, ModelAction[]>();

    for (const action of this.actions.values()) {
      if (action.category === "command") {
        commands.push(action);
      } else {
        const parent = action.parent ?? "__none__";
        const group = subAgentsByParent.get(parent) ?? [];
        group.push(action);
        subAgentsByParent.set(parent, group);
      }
    }

    commands.sort((a, b) => a.id.localeCompare(b.id));

    const result: ModelAction[] = [...commands];

    // Append sub-agents grouped by parent (in parent registration order)
    for (const command of commands) {
      const subs = subAgentsByParent.get(command.id);
      if (subs) {
        subs.sort((a, b) => a.id.localeCompare(b.id));
        result.push(...subs);
        subAgentsByParent.delete(command.id);
      }
    }

    // Any orphan sub-agents (parent not registered as command)
    for (const subs of subAgentsByParent.values()) {
      subs.sort((a, b) => a.id.localeCompare(b.id));
      result.push(...subs);
    }

    return result;
  }

  listByCategory(category: ModelActionCategory): ModelAction[] {
    return this.list().filter((a) => a.category === category);
  }
}
