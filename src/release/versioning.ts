export type ReleaseBump = "patch" | "minor" | "major";

interface SemverCore {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function normalizeSemver(value: string): string | undefined {
  const normalized = value.trim().replace(/^v/, "");
  return SEMVER_PATTERN.test(normalized) ? normalized : undefined;
}

function parseSemverCore(value: string): SemverCore | undefined {
  const normalized = normalizeSemver(value);
  if (!normalized) return undefined;

  const match = normalized.match(SEMVER_PATTERN);
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function bumpSemver(version: string, bump: ReleaseBump): string {
  const parsed = parseSemverCore(version);
  if (!parsed) {
    throw new Error(`Invalid semver: ${version}`);
  }

  if (bump === "major") {
    return `${parsed.major + 1}.0.0`;
  }

  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export interface LatestTagMatch {
  tag: string;
  version: string;
}

export function pickLatestSemverTag(tags: string[]): LatestTagMatch | undefined {
  for (const tag of tags) {
    const version = normalizeSemver(tag);
    if (!version) continue;
    return { tag, version };
  }

  return undefined;
}

export function detectRecommendedBump(commitMessages: string[]): ReleaseBump {
  if (commitMessages.length === 0) return "patch";

  for (const message of commitMessages) {
    if (/(^|\n)BREAKING CHANGE:/i.test(message) || /^[a-z]+(?:\([^)]+\))?!:/im.test(message)) {
      return "major";
    }
  }

  for (const message of commitMessages) {
    if (/^feat(?:\([^)]+\))?:/im.test(message)) {
      return "minor";
    }
  }

  return "patch";
}
