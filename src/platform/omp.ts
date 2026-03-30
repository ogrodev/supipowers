import type { Platform, AgentSession, AgentSessionOptions } from "./types.js";
import { createPaths } from "./types.js";

export function createOmpAdapter(pi: any): Platform {
  return {
    name: "omp",
    registerCommand: (name, opts) => pi.registerCommand(name, opts),
    getCommands: () => pi.getCommands(),
    getActiveTools: () => pi.getActiveTools(),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    sendMessage: (content, opts) => {
      pi.sendMessage(content, {
        deliverAs: opts?.deliverAs ?? "steer",
        triggerTurn: opts?.triggerTurn ?? false,
      });
    },
    registerMessageRenderer: (type, fn) => pi.registerMessageRenderer(type, fn),

    setModel(model: string): void {
      pi.setModel(model);
    },
    getCurrentModel(): string {
      return pi.getCurrentModel?.() ?? "unknown";
    },
    getModelForRole(role: string): string | null {
      return pi.getModelForRole?.(role) ?? null;
    },

    on: (event: string, handler: any) => {
      if (event === "input") {
        pi.on("input", (evt: any, ctx: any) => {
          const result = handler(evt, ctx);
          if (result?.action === "handled") return { handled: true };
          if (result?.action === "transform") return { handled: true, text: result.text };
          return result;
        });
        return;
      }
      if (event === "session_before_compact") {
        pi.on("session.before_compacting", handler);
        return;
      }
      if (event === "session_compact") {
        pi.on("session.compacting", handler);
        return;
      }
      pi.on(event, handler);
    },

    createAgentSession: async (opts: AgentSessionOptions): Promise<AgentSession> => {
      const { createAgentSession } = pi.pi;
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
