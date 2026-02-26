import { loadPersistedViewMode, savePersistedViewMode } from "../storage/view-mode-store";

export type SupipowersViewMode = "compact" | "full";

const DEFAULT_VIEW_MODE: SupipowersViewMode = "compact";
const viewModeByCwd = new Map<string, SupipowersViewMode>();
const loadedCwds = new Set<string>();

function ensureLoaded(cwd: string): void {
  if (loadedCwds.has(cwd)) return;
  loadedCwds.add(cwd);

  const persisted = loadPersistedViewMode(cwd);
  if (!persisted) return;

  viewModeByCwd.set(cwd, persisted);
}

export function getViewMode(cwd: string): SupipowersViewMode {
  ensureLoaded(cwd);
  return viewModeByCwd.get(cwd) ?? DEFAULT_VIEW_MODE;
}

export function setViewMode(cwd: string, mode: SupipowersViewMode): SupipowersViewMode {
  ensureLoaded(cwd);
  viewModeByCwd.set(cwd, mode);
  savePersistedViewMode(cwd, mode);
  return mode;
}

export function toggleViewMode(cwd: string): SupipowersViewMode {
  const next: SupipowersViewMode = getViewMode(cwd) === "compact" ? "full" : "compact";
  return setViewMode(cwd, next);
}
