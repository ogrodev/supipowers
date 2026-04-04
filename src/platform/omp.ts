import type { Platform, AgentSession, AgentSessionOptions } from "./types.js";
import { createPaths } from "./types.js";

export function createOmpAdapter(api: any): Platform {
  return {
    name: "omp",
    registerCommand: (name, opts) => api.registerCommand(name, opts),
    getCommands: () => api.getCommands(),
    getActiveTools: () => api.getActiveTools(),
    exec: (cmd, args, opts) => api.exec(cmd, args, opts),
    sendMessage: (content, opts) => {
      api.sendMessage(content, {
        deliverAs: opts?.deliverAs ?? "steer",
        triggerTurn: opts?.triggerTurn ?? false,
      });
    },
    sendUserMessage: (text: string) => api.sendUserMessage(text),
    registerMessageRenderer: (type, fn) => api.registerMessageRenderer(type, fn),

    setModel(model: string): void {
      api.setModel(model);
    },
    getCurrentModel(): string {
      return api.getCurrentModel?.() ?? "unknown";
    },
    getModelForRole(role: string): string | null {
      return api.getModelForRole?.(role) ?? null;
    },

    on: (event: string, handler: any) => {
      if (event === "input") {
        api.on("input", (evt: any, ctx: any) => {
          const result = handler(evt, ctx);
          if (result?.action === "handled") return { handled: true };
          if (result?.action === "transform") return { handled: true, text: result.text };
          return result;
        });
        return;
      }
      if (event === "session_before_compact") {
        api.on("session.before_compacting", handler);
        return;
      }
      if (event === "session_compact") {
        api.on("session.compacting", handler);
        return;
      }
      api.on(event, handler);
    },

    createAgentSession: async (opts: AgentSessionOptions): Promise<AgentSession> => {
      const { createAgentSession } = api.pi;
      // OMP's createAgentSession expects model?: Model (full object), not a string.
      // Our AgentSessionOptions uses model?: string (model ID). If we spread a string
      // into the `model` field, OMP thinks an explicit model was provided, skips all
      // its fallback logic (settings default → first available), and then fails when
      // it accesses model.id on the string → "No API key found for undefined".
      // Fix: extract `model` from opts and pass it as `modelPattern` (string field
      // that OMP resolves after extension models are registered).
      const { model, ...restOpts } = opts;
      const { session } = await createAgentSession({
        cwd: restOpts.cwd ?? process.cwd(),
        hasUI: false,
        disableExtensionDiscovery: true,
        skills: [],
        promptTemplates: [],
        slashCommands: [],
        ...restOpts,
        // Only pass modelPattern when we have an explicit model override.
        // When undefined, OMP uses its own default (user's configured model).
        ...(model ? { modelPattern: model } : {}),
      });
      return {
        subscribe: (handler: any) => session.subscribe(handler),
        prompt: (text: string, promptOpts?: any) => session.prompt(text, promptOpts),
        state: session.state,
        dispose: () => session.dispose(),
      };
    },

    paths: createPaths(".omp"),
    capabilities: {
      agentSessions: true,
      compactionHooks: true,
      customWidgets: true,
      registerTool: false,
    },
  };
}
