import type { Platform } from "../platform/types.js";

/**
 * Open a file in the user's preferred editor and wait for the editor to exit.
 *
 * Resolution order:
 *  1. `$VISUAL`
 *  2. `$EDITOR`
 *  3. OS default opener (`open` on darwin, `start` on win32, `xdg-open` elsewhere)
 *
 * `platform.exec` blocks until the spawned editor process exits, which is what
 * the synthesize stage needs for its `$EDITOR` round-trip. For OS-default openers
 * on darwin and linux, the spawned process returns immediately — callers that
 * need true blocking behavior on save must set `$VISUAL` or `$EDITOR` explicitly
 * (which is the documented requirement for the synth round-trip).
 *
 * Errors are non-fatal — if the editor can't be launched, the function returns
 * without throwing. Callers that need to verify the user actually edited the file
 * should detect changes by comparing mtime / contents before and after.
 */
export async function openInEditor(platform: Platform, filePath: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  try {
    if (editor) {
      // Tokenize on whitespace so users can set EDITOR="code --wait" etc.
      const tokens = editor.split(/\s+/).filter((t) => t.length > 0);
      const cmd = tokens[0];
      const args = [...tokens.slice(1), filePath];
      await platform.exec(cmd, args);
    } else {
      const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start" : "xdg-open";
      await platform.exec(cmd, [filePath]);
    }
  } catch {
    // Editor open failed — non-fatal, file was still written
  }
}
