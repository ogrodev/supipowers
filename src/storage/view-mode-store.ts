import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir } from "./state-store";
import type { SupipowersViewMode } from "../ui/view-mode";

const VIEW_MODE_FILE = "view-mode.json";

interface PersistedViewMode {
  viewMode: SupipowersViewMode;
}

function viewModePath(cwd: string): string {
  return join(cwd, ".pi", "supipowers", VIEW_MODE_FILE);
}

export function loadPersistedViewMode(cwd: string): SupipowersViewMode | undefined {
  const path = viewModePath(cwd);
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<PersistedViewMode>;
    if (parsed.viewMode === "compact" || parsed.viewMode === "full") {
      return parsed.viewMode;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function savePersistedViewMode(cwd: string, mode: SupipowersViewMode): void {
  ensureStateDir(cwd);
  const path = viewModePath(cwd);
  const payload: PersistedViewMode = { viewMode: mode };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}
