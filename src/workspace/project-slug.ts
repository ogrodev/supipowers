import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Version of the slug derivation scheme. Bumping this is a breaking change: every user's
 * global state directories become orphaned because their previously derived slugs no longer
 * match what {@link projectSlugFromRepoRoot} produces. Do not bump without a migration plan.
 */
export const SLUG_SCHEMA_VERSION = 1;

/**
 * Fixed length of the hex hash suffix that appears after the human-readable basename portion.
 * 16 hex chars = 64 bits, which makes accidental collisions vanishingly unlikely while keeping
 * slugs readable on disk.
 */
const HASH_HEX_LEN = 16;

/**
 * Maximum length of the basename portion. Keeps slugs filesystem-safe on Windows where
 * total path budget can be tight, while still preserving enough context for humans to
 * recognize which repo owns a given global session directory.
 */
const MAX_BASENAME_PORTION_LEN = 40;

function sanitizeBasename(raw: string): string {
  // Lowercase, collapse anything that is not alphanumeric to a single hyphen, and trim hyphens.
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  // Fall back to a stable placeholder when the basename is entirely non-alphanumeric
  // (e.g. `/` or a directory named `___`). The hash portion still disambiguates.
  const base = trimmed.length > 0 ? trimmed : "project";
  return base.length > MAX_BASENAME_PORTION_LEN
    ? base.slice(0, MAX_BASENAME_PORTION_LEN)
    : base;
}

/**
 * Derive a deterministic project slug from the absolute repo root path.
 *
 * Guarantees:
 * - Stable for the same absolute input across calls and platforms.
 * - Two distinct absolute inputs never produce the same slug (up to SHA-256 collision bounds).
 * - Two inputs that differ only in case still produce distinct slugs on case-sensitive filesystems.
 * - Normalization-stable: trailing slashes and redundant separators do not change the slug.
 *
 * Fail-closed:
 * - Throws on non-absolute, empty, or whitespace-only input. The delta spec requires fail-closed
 *   behavior so migration and runtime truth never silently merge distinct projects.
 */
export function projectSlugFromRepoRoot(repoRoot: string): string {
  if (typeof repoRoot !== "string") {
    throw new TypeError("projectSlugFromRepoRoot: repoRoot must be a string");
  }

  const trimmed = repoRoot.trim();
  if (trimmed.length === 0) {
    throw new Error("projectSlugFromRepoRoot: repoRoot must not be empty");
  }

  if (!path.isAbsolute(trimmed)) {
    throw new Error(
      `projectSlugFromRepoRoot: repoRoot must be an absolute path, received: ${repoRoot}`,
    );
  }

  // path.normalize collapses redundant separators but preserves trailing slashes; strip them
  // so "/foo/" and "/foo" produce the same slug. Preserve filesystem root "/".
  const normalized = stripTrailingSeparators(path.normalize(trimmed));

  // Always hash the normalized absolute path so the slug is a pure function of filesystem
  // identity. The hash portion disambiguates across projects that share a basename.
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, HASH_HEX_LEN);

  const basenamePortion = sanitizeBasename(path.basename(normalized));

  return `${basenamePortion}-${hash}`;
}

function stripTrailingSeparators(value: string): string {
  // Never strip the filesystem root ("/" on POSIX, "C:\\" on Windows).
  if (value.length <= 1) return value;
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end--;
  }
  // Preserve Windows drive roots like "C:\\" (length 3) — stripping would yield "C:" which is not absolute.
  if (/^[A-Za-z]:[\/\\]?$/.test(value.slice(0, Math.min(3, value.length)))) {
    return value.slice(0, Math.max(end, 3));
  }
  return value.slice(0, end);
}
