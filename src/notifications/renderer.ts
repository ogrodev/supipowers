import type { Notification } from "../types.js";
import { LEVEL_ICONS, NOTIFY_TYPE_MAP } from "./types.js";

/** Format a notification into a styled text string */
export function formatNotification(notification: Notification): string {
  const icon = LEVEL_ICONS[notification.level] ?? "";
  const parts = [`${icon} ${notification.title}`];
  if (notification.detail) {
    parts.push(` \u2014 ${notification.detail}`);
  }
  return parts.join("");
}

/** Send a notification through OMP's UI */
export function sendNotification(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  notification: Notification
): void {
  const message = formatNotification(notification);
  const type = NOTIFY_TYPE_MAP[notification.level] ?? "info";
  ctx.ui.notify(message, type);
}

/** Convenience: send a success notification */
export function notifySuccess(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "success", title, detail });
}

/** Convenience: send a warning notification */
export function notifyWarning(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "warning", title, detail });
}

/** Convenience: send an error notification */
export function notifyError(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "error", title, detail });
}

/** Convenience: send an info notification */
export function notifyInfo(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "info", title, detail });
}

/** Convenience: send a summary notification */
export function notifySummary(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "summary", title, detail });
}
