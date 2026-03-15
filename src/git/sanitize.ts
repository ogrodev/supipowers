/**
 * Validate a git ref name for safe interpolation into shell commands.
 * Rejects names containing shell metacharacters, whitespace, or git-invalid sequences.
 * Follows git-check-ref-format rules plus shell safety.
 */
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/;
const BANNED = /\.\.|\/{2}|@\{|[~^:?*\[\\]/;

export function assertSafeRef(value: string, label: string): void {
  if (!value || !SAFE_REF.test(value) || BANNED.test(value) || value.endsWith(".lock") || value.endsWith("/") || value.endsWith(".")) {
    throw new Error(`Unsafe ${label}: "${value}" contains characters not allowed in git ref names or shell commands`);
  }
}

export function assertSafePath(value: string, label: string): void {
  if (!value || /[;&|`$(){}!#<>'"\\]/.test(value)) {
    throw new Error(`Unsafe ${label}: "${value}" contains shell metacharacters`);
  }
}
