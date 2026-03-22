import type { Platform, AgentSession, AgentSessionOptions } from "./types.js";
import { createPaths } from "./types.js";

export function createPiAdapter(pi: any): Platform {
  return {
    name: "pi",
    registerCommand: (name, opts) => pi.registerCommand(name, opts),
    getCommands: () => pi.getCommands(),
    getActiveTools: () => pi.getActiveTools(),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    sendMessage: (content, opts) => {
      pi.sendMessage(content, {
        deliverAs: opts?.deliverAs ?? "steer",
        triggerTurn: opts?.triggerTurn ?? true,
        ...opts,
      });
    },
    registerMessageRenderer: (type, fn) => pi.registerMessageRenderer(type, fn),
    on: (event, handler) => pi.on(event, handler),

    createAgentSession: async (opts: AgentSessionOptions): Promise<AgentSession> => {
      const mod = await import("@mariozechner/pi-coding-agent");
      const createFn = (mod as any).createAgentSession;
      const { session } = await createFn({
        cwd: opts.cwd ?? process.cwd(),
        hasUI: false,
        ...opts,
      });
      return {
        subscribe: (handler: any) => session.subscribe(handler),
        prompt: (text: string, promptOpts?: any) => session.prompt(text, promptOpts),
        state: session.state,
        dispose: () => session.dispose(),
      };
    },

    paths: createPaths(".pi"),
    capabilities: {
      agentSessions: true,
      compactionHooks: true,
      customWidgets: true,
      registerTool: true,
    },
  };
}
