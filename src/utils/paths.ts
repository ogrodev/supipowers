import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * Returns the directory of the calling module, correctly resolved on all
 * platforms.
 *
 * The naive alternative — `path.dirname(new URL(import.meta.url).pathname)` —
 * is broken on Windows: `URL.pathname` for a `file:///C:/foo/bar.ts` URL
 * yields `/C:/foo/bar.ts` (leading slash before the drive letter), which
 * `path.dirname` on Windows converts to a backslash path. Those backslashes,
 * when later embedded in a bash command, are consumed as escape sequences and
 * silently corrupt the path.
 *
 * `fileURLToPath` handles the Windows case correctly, stripping the leading
 * slash and returning a proper `C:\foo\bar.ts` path.
 *
 * @param importMetaUrl Pass `import.meta.url` from the caller.
 */
export function moduleDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Normalizes path separators to forward slashes so the path is safe to embed
 * in bash commands or shell-script arguments on Windows.
 *
 * Git Bash (and WSL) on Windows interpret `\` as an escape character, so a
 * native Windows path like `C:\Users\foo\bar` silently becomes `C:Usersfoobar`
 * when passed as a bash argument. Forward slashes are accepted by both Git
 * Bash and Node.js file APIs on Windows, so this conversion is safe to apply
 * universally.
 *
 * Use on every path that will be passed to `platform.exec("bash", [...])` or
 * embedded as a literal in an AI prompt that contains bash commands.
 */
export function toBashPath(p: string): string {
  return p.replace(/\\/g, "/");
}
