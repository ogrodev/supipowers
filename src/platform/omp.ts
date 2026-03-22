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
        triggerTurn: opts?.triggerTurn ?? true,
      });
    },
    registerMessageRenderer: (type, fn) => pi.registerMessageRenderer(type, fn),

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
      const { session } = await createAgentSession({
        cwd: opts.cwd ?? process.cwd(),
        hasUI: false,
        disableExtensionDiscovery: true,
        skills: [],
        promptTemplates: [],
        slashCommands: [],
        ...opts,
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
