import type { Platform, AgentSession, AgentSessionOptions } from "./types.js";
import { createPaths } from "./types.js";

export function createPiAdapter(pi: any): Platform {
  return {
    name: "pi",
    registerCommand: (name, opts) => pi.registerCommand(name, opts),
    getCommands: () => pi.getCommands(),
    getActiveTools: () => pi.getActiveTools(),
    registerTool: (definition) => pi.registerTool(definition),
    setActiveTools: (names) => pi.setActiveTools(names),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    sendMessage: (content, opts) => {
      pi.sendMessage(content, {
        deliverAs: opts?.deliverAs ?? "steer",
        triggerTurn: opts?.triggerTurn ?? true,
      });
    },
    registerMessageRenderer: (type, fn) => pi.registerMessageRenderer(type, fn),

    setModel(_model: string): void {
      // Pi doesn't support runtime model switching
    },
    getCurrentModel(): string {
      return "unknown";
    },
    getModelForRole(_role: string): string | null {
      return null;
    },

    on: (event, handler) => pi.on(event, handler),

    createAgentSession: async (opts: AgentSessionOptions): Promise<AgentSession> => {
      const mod = await import("@mariozechner/pi-coding-agent");
      const createFn = (mod as any).createAgentSession;
      // Same fix as OMP adapter: model is a string ID, not a Model object.
      // Use modelPattern for string-based model resolution.
      const { model, ...restOpts } = opts;
      const { session } = await createFn({
        cwd: restOpts.cwd ?? process.cwd(),
        hasUI: false,
        ...restOpts,
        ...(model ? { modelPattern: model } : {}),
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
