export type { Notification, NotificationLevel } from "../types.js";

/** Icons mapped to notification levels */
export const LEVEL_ICONS: Record<string, string> = {
  success: "\u2713",  // ✓
  warning: "\u26A0",  // ⚠
  error: "\u2717",    // ✗
  info: "\u25C9",     // ◉
  summary: "\u25B8",  // ▸
};

/** Map notification levels to ctx.ui.notify types */
export const NOTIFY_TYPE_MAP: Record<string, "info" | "warning" | "error"> = {
  success: "info",
  warning: "warning",
  error: "error",
  info: "info",
  summary: "info",
};
