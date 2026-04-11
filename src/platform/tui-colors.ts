// Shared ANSI escape codes and TUI styling helpers.
// Import from here instead of defining local constants per module.

// ── Raw ANSI codes ──────────────────────────────────────────

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const INVERSE = "\x1b[7m";

export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const WHITE = "\x1b[37m";
export const ORANGE = "\x1b[38;5;214m";
export const TEXT_COLOR = "\x1b[38;5;252m"; // #ccc equivalent

// ── Semantic helpers ────────────────────────────────────────

export const accent = (t: string) => `${CYAN}${BOLD}${t}${RESET}`;
export const muted = (t: string) => `${DIM}${t}${RESET}`;
export const bright = (t: string) => `${WHITE}${BOLD}${t}${RESET}`;
export const warn = (t: string) => `${YELLOW}${t}${RESET}`;
export const success = (t: string) => `${GREEN}${t}${RESET}`;
export const error = (t: string) => `${RED}${t}${RESET}`;

// ── Animation ───────────────────────────────────────────────

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
