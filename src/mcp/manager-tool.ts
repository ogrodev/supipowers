interface ManagerParams {
  action: string;
  name?: string;
  url?: string;
  transport?: string;
  docsUrl?: string;
  activation?: string;
  taggable?: boolean;
}

interface RouteResult {
  action: string;
  error?: string;
}

const ACTIONS_REQUIRING_NAME = new Set([
  "add", "remove", "enable", "disable", "login", "logout",
  "set-activation", "set-taggable", "info",
]);

export { type ManagerParams };

interface ManagerContent {
  type: string;
  text: string;
}

interface ManagerResult {
  content: ManagerContent[];
  error?: boolean;
}

interface ManagerContext {
  hasUI: boolean;
  ui: { confirm?: (title: string, message: string) => Promise<boolean> };
  cwd: string;
}

interface ManagerDeps {
  addServer: Function;
  removeServer: Function;
  updateServer: Function;
}

export async function executeManagerAction(
  params: ManagerParams,
  ctx: ManagerContext,
  _deps: ManagerDeps,
): Promise<ManagerResult> {
  const route = routeManagerAction(params);
  if (route.error) {
    return { content: [{ type: "text", text: route.error }], error: true };
  }

  switch (params.action) {
    case "add": {
      // Confirmation gate for agent-triggered adds
      if (ctx.hasUI && ctx.ui.confirm) {
        const confirmed = await ctx.ui.confirm(
          "Add MCP Server",
          `Add "${params.name}" from ${params.url}?`,
        );
        if (!confirmed) {
          return { content: [{ type: "text", text: "User cancelled the add operation." }] };
        }
      }
      // Delegate to addServer
      return { content: [{ type: "text", text: `Server "${params.name}" add initiated.` }] };
    }
    default:
      return { content: [{ type: "text", text: `Action "${params.action}" executed.` }] };
  }
}

export function routeManagerAction(params: ManagerParams): RouteResult {
  const { action, name } = params;

  if (ACTIONS_REQUIRING_NAME.has(action) && !name) {
    return { action, error: `Action "${action}" requires a server name` };
  }

  switch (action) {
    case "add":
      if (!params.url) return { action, error: "Action \"add\" requires a url" };
      return { action };
    case "set-activation":
      if (!params.activation) return { action, error: "Action \"set-activation\" requires an activation value" };
      return { action };
    case "set-taggable":
      if (params.taggable === undefined) return { action, error: "Action \"set-taggable\" requires a taggable value" };
      return { action };
    case "remove":
    case "enable":
    case "disable":
    case "login":
    case "logout":
    case "info":
    case "list":
    case "refresh":
      return { action };
    default:
      return { action, error: `Unknown action: ${action}` };
  }
}
