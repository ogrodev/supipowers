/**
 * Layer-glob matcher used by the docs stage.
 *
 * Lifted from the architecture-parser regex shape so the docs stage uses the same
 * matching semantics as the layer-context-inject hook. Supports `**` (any path
 * segments) and `*` (any single-segment characters). All matching is forward-slashed.
 */

/**
 * Naive glob matcher tuned for the conventions parsed from architecture tables. Supports
 * `**` (any path segments) and `*` (any single segment characters). Sufficient for the
 * `src/<layer>/**` and `packages/<scope>/**\/*.ts` shapes the doc relies on.
 */
export function matchesLayerGlob(filePath: string, glob: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedGlob = glob.replace(/\\/g, "/");
  const regexSrc = normalizedGlob
    .split(/(\*\*|\*)/g)
    .map((segment) => {
      if (segment === "**") return ".*";
      if (segment === "*") return "[^/]*";
      return segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const regex = new RegExp(`^${regexSrc}$`);
  return regex.test(normalizedFile);
}
