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
