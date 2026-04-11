/**
 * Custom TUI model picker component for /supi:model.
 *
 * Replicates OMP's native /model experience:
 * - TabBar for provider filtering (configured providers + SHOW ALL toggle)
 * - Input for search/filter
 * - Scrollable model list with provider/model-id format
 * - Unconfigured provider warning in footer
 *
 * Uses ctx.ui.custom() to get TUI/Theme/Keybindings access.
 */
import {
  type Component,
  type Focusable,
  Input,
  TabBar,
  type Tab,
  type TabBarTheme,
  matchesKey,
  truncateToWidth,
} from "@oh-my-pi/pi-tui";
import {
  getBundledProviders,
  getBundledModels,
  type GeneratedProvider,
} from "@oh-my-pi/pi-ai";

import {
  RESET, BOLD, DIM, CYAN, INVERSE,
  accent, muted, bright, warn,
} from "../platform/tui-colors.js";

const ALL_TAB = "ALL";
const MAX_VISIBLE = 12;

/** Set of available (authenticated) providers and model IDs, from ctx.modelRegistry */
export interface AvailableModelSet {
  providers: Set<string>;
  modelIds: Set<string>;
}

interface ModelItem {
  provider: string;
  id: string;
  displayLabel: string; // "provider/model-id"
  configured: boolean;  // provider has auth
}


/**
 * Build the flat model list from bundled providers.
 * @param available — if provided, marks models whose provider has auth
 */
function loadAllModels(available?: AvailableModelSet): { items: ModelItem[]; configuredProviders: Set<string> } {
  const providers = getBundledProviders();
  const items: ModelItem[] = [];
  const configuredProviders = new Set<string>();

  for (const provider of providers) {
    const name = String(provider);
    const configured = available ? available.providers.has(name) : true;
    if (configured) configuredProviders.add(name);

    const models = getBundledModels(provider as GeneratedProvider);
    for (const m of models) {
      items.push({
        provider: name,
        id: m.id,
        displayLabel: `${name}/${m.id}`,
        configured,
      });
    }
  }

  // Sort like OMP's native /model: provider → version desc → -latest first → date desc → alpha
  const dateRe = /-(\d{8})$/;
  const latestRe = /-latest$/;

  items.sort((a, b) => {
    // Group by provider
    const provCmp = a.provider.localeCompare(b.provider);
    if (provCmp !== 0) return provCmp;

    // Version number descending (higher = newer model)
    const aVer = extractVersionNumber(a.id);
    const bVer = extractVersionNumber(b.id);
    if (aVer !== bVer) return bVer - aVer;

    // Recency: models with -latest or YYYYMMDD suffix come first
    const aIsLatest = latestRe.test(a.id);
    const bIsLatest = latestRe.test(b.id);
    const aDate = a.id.match(dateRe)?.[1] ?? "";
    const bDate = b.id.match(dateRe)?.[1] ?? "";
    const aHasRecency = aIsLatest || aDate !== "";
    const bHasRecency = bIsLatest || bDate !== "";

    if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;
    if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;
    if (aDate && bDate) return bDate.localeCompare(aDate); // newest first

    return a.id.localeCompare(b.id);
  });

  return { items, configuredProviders };
}

/**
 * Extract a version number from a model ID for sorting.
 * Matches OMP's native extractVersionNumber logic.
 */
function extractVersionNumber(id: string): number {
  // Dot-separated: "gemini-2.5-pro" → 2.5
  const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
  if (dotMatch) return Number.parseFloat(dotMatch[1]);
  // Dash-separated: "claude-sonnet-4-6" → 4.6
  const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
  if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
  // Single number: "gpt-4o" → 4
  const singleMatch = id.match(/(?:^|[-_])(\d+)/);
  if (singleMatch) return Number.parseFloat(singleMatch[1]);
  return 0;
}

/**
 * Model picker TUI component.
 *
 * Created via `ctx.ui.custom()` factory — receives TUI, Theme, done callback.
 */
export function createModelPicker(
  tui: any,
  _theme: any,
  _keybindings: any,
  done: (result: string | null) => void,
  available?: AvailableModelSet,
): Component & Focusable & { dispose(): void } {
  const { items: allModels, configuredProviders } = loadAllModels(available);
  const hasConfigured = configuredProviders.size > 0;

  // Build provider tabs — only configured providers
  const configuredUpper = new Set([...configuredProviders].map((p) => p.toUpperCase()));

  const providerTabs: Tab[] = [
    { id: ALL_TAB, label: ALL_TAB },
    ...[...configuredUpper].sort().map((p) => ({ id: p, label: p })),
  ];

  // Tab bar theme
  const tabBarTheme: TabBarTheme = {
    label: accent,
    activeTab: (t: string) => `${INVERSE}${CYAN}${t}${RESET}`,
    inactiveTab: muted,
    hint: muted,
  };

  const tabBar = new TabBar(
    "Models",
    providerTabs,
    tabBarTheme,
  );

  // Search input
  const searchInput = new Input();
  searchInput.focused = true;

  // State
  let activeProvider = ALL_TAB;
  let filteredModels: ModelItem[] = [];
  let selectedIndex = 0;

  function applyFilter(): void {
    const searchTerm = searchInput.getValue().toLowerCase();
    const isProviderTab = activeProvider !== ALL_TAB;
    const providerFilter = isProviderTab ? activeProvider.toLowerCase() : null;

    filteredModels = allModels.filter((m) => {
      // Provider tab filter
      if (providerFilter && m.provider.toLowerCase() !== providerFilter) return false;
      // Only show configured models (when we have auth info)
      if (hasConfigured && !m.configured) return false;
      // Text search — when on a provider tab, search model ID only;
      // on ALL tab, search the full provider/model-id label
      if (searchTerm) {
        const haystack = providerFilter ? m.id.toLowerCase() : m.displayLabel.toLowerCase();
        if (!haystack.includes(searchTerm)) return false;
      }
      return true;
    });
    selectedIndex = Math.min(selectedIndex, Math.max(0, filteredModels.length - 1));
  }

  // Wire tab changes
  tabBar.onTabChange = (tab: Tab) => {
    activeProvider = tab.id;
    applyFilter();
    tui.requestRender();
  };

  // Wire search input changes — refilter on each keystroke
  const origHandleInput = searchInput.handleInput.bind(searchInput);

  // Initial filter
  applyFilter();

  return {
    focused: true,

    dispose(): void {
      // No cleanup needed
    },

    invalidate(): void {
      // No cached state
    },

    handleInput(data: string): void {
      // Escape → cancel
      if (matchesKey(data, "escape")) {
        done(null);
        return;
      }

      // Enter → select current model
      if (matchesKey(data, "enter")) {
        if (filteredModels.length > 0) {
          done(`${filteredModels[selectedIndex].provider}/${filteredModels[selectedIndex].id}`);
        }
        return;
      }

      // Arrow up
      if (matchesKey(data, "up")) {
        if (filteredModels.length > 0) {
          selectedIndex = selectedIndex === 0
            ? filteredModels.length - 1
            : selectedIndex - 1;
          tui.requestRender();
        }
        return;
      }

      // Arrow down
      if (matchesKey(data, "down")) {
        if (filteredModels.length > 0) {
          selectedIndex = selectedIndex === filteredModels.length - 1
            ? 0
            : selectedIndex + 1;
          tui.requestRender();
        }
        return;
      }

      // Tab / Shift+Tab → cycle provider tabs
      if (tabBar.handleInput(data)) {
        return;
      }

      // Everything else → search input
      origHandleInput(data);
      applyFilter();
      tui.requestRender();
    },

    render(width: number): string[] {
      const lines: string[] = [];

      // 1. Tab bar
      lines.push(...tabBar.render(width));
      lines.push("");

      // 2. Search input (Input already renders "> " prefix)
      lines.push(...searchInput.render(width));
      lines.push("");

      // 3. Model list
      if (filteredModels.length === 0) {
        lines.push(muted("  No matching models"));
      } else {
        // Scrolling window
        const maxVisible = Math.min(MAX_VISIBLE, filteredModels.length);
        const startIndex = Math.max(
          0,
          Math.min(
            selectedIndex - Math.floor(maxVisible / 2),
            filteredModels.length - maxVisible,
          ),
        );
        const endIndex = Math.min(startIndex + maxVisible, filteredModels.length);

        for (let i = startIndex; i < endIndex; i++) {
          const item = filteredModels[i];
          const isSelected = i === selectedIndex;

          if (isSelected) {
            const cursor = accent("> ");
            const label = bright(item.displayLabel);
            const badge = !item.configured ? ` ${warn("(no key)")}` : "";
            lines.push(`${cursor}${label}${badge}`);
          } else {
            const badge = !item.configured ? ` ${DIM}(no key)${RESET}` : "";
            lines.push(`  ${muted(item.displayLabel)}${badge}`);
          }
        }

        // Scroll info
        if (filteredModels.length > maxVisible) {
          lines.push(
            muted(`  (${selectedIndex + 1}/${filteredModels.length})`),
          );
        }
      }

      // 4. Footer
      lines.push("");
      if (filteredModels.length > 0 && filteredModels[selectedIndex]) {
        const selected = filteredModels[selectedIndex];
        const keyWarning = !selected.configured ? ` ${warn("⚠ no API key detected")}` : "";
        lines.push(
          muted(`Model: ${selected.provider}/${selected.id}`) + keyWarning,
        );
      }

      lines.push(
        muted("Type to filter · Tab to switch provider · Esc to cancel"),
      );

      return lines.map((line) => truncateToWidth(line, width));
    },
  };
}
