import type { WorkspaceTarget } from "../types.js";

export interface WorkspaceTargetOption<TTarget extends WorkspaceTarget = WorkspaceTarget> {
  target: TTarget;
  changed: boolean;
  label?: string;
}

export function tokenizeCliArgs(args?: string): string[] {
  if (!args) {
    return [];
  }

  return (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

export function stripCliArg(args: string | undefined, flag: string): string | undefined {
  const tokens = tokenizeCliArgs(args);
  const retained: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === flag) {
      index += 1;
      continue;
    }
    if (token.startsWith(`${flag}=`)) {
      continue;
    }
    retained.push(token);
  }

  return retained.length > 0 ? retained.join(" ") : undefined;
}

export function parseTargetArg(args?: string): string | null {
  const tokens = tokenizeCliArgs(args);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--target") {
      return tokens[index + 1] ?? null;
    }
    if (token.startsWith("--target=")) {
      return token.slice("--target=".length) || null;
    }
  }

  return null;
}

export function resolveRequestedWorkspaceTarget<TTarget extends WorkspaceTarget>(
  targets: TTarget[],
  requestedTarget: string | null,
): TTarget | null {
  if (!requestedTarget) {
    return null;
  }

  return targets.find((target) => target.id === requestedTarget || target.name === requestedTarget) ?? null;
}

export function sortWorkspaceTargetOptions<TTarget extends WorkspaceTarget>(
  options: WorkspaceTargetOption<TTarget>[],
): WorkspaceTargetOption<TTarget>[] {
  return [...options].sort((left, right) => {
    if (left.changed !== right.changed) {
      return left.changed ? -1 : 1;
    }
    return left.target.name.localeCompare(right.target.name);
  });
}

export function buildWorkspaceTargetOptionLabel(
  option: WorkspaceTargetOption,
  details: string[] = [],
): string {
  return [
    option.target.name,
    option.target.relativeDir,
    ...details.map((detail) => detail.trim()).filter(Boolean),
  ].join(" — ");
}

export async function selectWorkspaceTarget<TTarget extends WorkspaceTarget>(
  ctx: { ui: { select(title: string, options: string[], opts?: any): Promise<string | null> } },
  options: WorkspaceTargetOption<TTarget>[],
  requestedTarget: string | null,
  selection: {
    title: string;
    helpText?: string;
    autoSelectSingle?: boolean;
  },
): Promise<TTarget | null> {
  if (requestedTarget) {
    return resolveRequestedWorkspaceTarget(options.map((option) => option.target), requestedTarget);
  }

  const autoSelectSingle = selection.autoSelectSingle ?? true;
  if (autoSelectSingle && options.length === 1) {
    return options[0]?.target ?? null;
  }

  const labels = options.map((option) => option.label ?? buildWorkspaceTargetOptionLabel(option));
  const choice = await ctx.ui.select(selection.title, labels, {
    helpText: selection.helpText,
  });
  if (!choice) {
    return null;
  }

  const selectedIndex = labels.indexOf(choice);
  return selectedIndex >= 0 ? options[selectedIndex]?.target ?? null : null;
}
