import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { SupipowersConfig, WorkflowState } from "../types";
import { buildCompactStatusLine, buildStatusLine } from "./status";
import { buildWidgetLines } from "./widget";
import { getViewMode } from "./view-mode";

export interface RenderUiOptions {
  fullStatusSuffix?: string;
  fullWidgetAppend?: string[];
}

export function renderSupipowersUi(
  ctx: Pick<ExtensionContext, "hasUI" | "cwd" | "ui">,
  config: SupipowersConfig,
  state: WorkflowState,
  options?: RenderUiOptions,
): void {
  if (!ctx.hasUI) return;

  const mode = getViewMode(ctx.cwd);

  const compactLine = buildCompactStatusLine(state);
  const statusText = mode === "compact"
    ? compactLine
    : `${buildStatusLine(state, config.strictness)}${options?.fullStatusSuffix ?? ""}`;

  // Keep footer status updated (when terminal/footer supports status slots).
  ctx.ui.setStatus("supipowers", statusText);

  if (mode === "full") {
    const lines = buildWidgetLines(state, config.strictness);
    if (options?.fullWidgetAppend?.length) {
      lines.push(...options.fullWidgetAppend);
    }
    // Reliable visual fallback rendered near footer.
    ctx.ui.setWidget("supipowers", lines, { placement: "belowEditor" });
  } else {
    // Compact one-liner rendered near footer. Use custom component to avoid list/line padding.
    ctx.ui.setWidget(
      "supipowers",
      (_tui, theme) => new Text(theme.fg("accent", compactLine), 0, 0),
      { placement: "belowEditor" },
    );
  }
}
