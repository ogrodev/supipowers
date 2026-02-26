import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadState } from "../storage/state-store";

const taskRegex = /(implement|build|create|refactor|fix|ship|add feature)/i;
const reminderCooldownMs = 45_000;
const lastReminderByCwd = new Map<string, number>();

export function registerInputInterceptor(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return;
    if (event.text.trim().startsWith("/sp-")) return;
    if (!taskRegex.test(event.text)) return;

    const state = loadState(ctx.cwd);
    if (state.phase !== "idle") return;

    const now = Date.now();
    const last = lastReminderByCwd.get(ctx.cwd) ?? 0;
    if (now - last < reminderCooldownMs) return;

    lastReminderByCwd.set(ctx.cwd, now);
    if (ctx.hasUI) {
      ctx.ui.notify("Tip: run /sp-start to initialize Supipowers workflow before implementation.", "info");
    }
  });
}
