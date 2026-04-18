import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * Returns the directory of the calling module, correctly resolved on all
 * platforms.
 *
 * The naive alternative — `path.dirname(new URL(import.meta.url).pathname)` —
 * is broken on Windows: `URL.pathname` for a `file:///C:/foo/bar.ts` URL
 * yields `/C:/foo/bar.ts` (leading slash before the drive letter), which
 * `path.dirname` on Windows converts to a backslash path.
 *
 * `fileURLToPath` handles the Windows case correctly, stripping the leading
 * slash and returning a proper `C:\foo\bar.ts` path.
 *
 * @param importMetaUrl Pass `import.meta.url` from the caller.
 */
export function moduleDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}
