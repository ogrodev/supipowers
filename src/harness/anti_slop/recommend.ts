/**
 * Anti-slop backend recommendation.
 *
 * Inputs come from Discover (`HarnessDiscoverArtifact.languageCoverage`). We pick a
 * backend per the algorithm spelled out in the plan §3.5:
 *
 *   languages = unique(detect_languages(repo))
 *   if languages == {typescript, javascript}:
 *     recommend "fallow + supi-native"
 *   elif languages.size >= 3 OR python in languages OR rust in languages OR go in languages:
 *     recommend "desloppify under the hood"
 *   elif languages == {typescript} but pkg has subdirs in other languages:
 *     recommend "hybrid"
 *   else:
 *     recommend "supi-native only"
 *
 * The "subdirs in other languages" check uses the `languageCoverage` array — when the
 * dominant language has share <90% AND a non-TS-family language has >0 files, the repo is
 * polyglot enough to warrant the hybrid backend.
 */

import type { HarnessAntiSlopBackend } from "../../types.js";

const TS_FAMILY = new Set(["typescript", "javascript", "tsx", "jsx"]);
const HEAVY_LANGUAGES = new Set(["python", "rust", "go"]);

export interface RecommendInput {
  languageCoverage: { language: string; fileCount: number; share: number }[];
}

export interface Recommendation {
  backend: HarnessAntiSlopBackend;
  reason: string;
}

export function recommendBackend(input: RecommendInput): Recommendation {
  const languages = input.languageCoverage
    .map((c) => c.language.toLowerCase())
    .filter((l) => l.length > 0);

  if (languages.length === 0) {
    return {
      backend: "supi-native",
      reason: "no detectable language coverage; defer to manual lint/dupe per stack",
    };
  }

  const langSet = new Set(languages);

  // TS-family-only repo → fallow (deepest supipowers integration, no Python dep).
  const allTsFamily = languages.every((lang) => TS_FAMILY.has(lang));
  if (allTsFamily && langSet.size <= 2) {
    return {
      backend: "fallow",
      reason: "TS/JS-only repo; fallow ships native binaries for all three OSes",
    };
  }

  // ≥3 languages or any heavy non-TS language → desloppify (29-language coverage).
  const heavyPresent = languages.some((lang) => HEAVY_LANGUAGES.has(lang));
  if (langSet.size >= 3 || heavyPresent) {
    return {
      backend: "desloppify",
      reason:
        langSet.size >= 3
          ? "polyglot repo (≥3 languages); desloppify covers 29 languages with one CLI"
          : `non-TS heavy language present (${[...langSet].filter((l) => HEAVY_LANGUAGES.has(l)).join(", ")}); desloppify covers it`,
    };
  }

  // TS-dominant but with non-TS subtrees → hybrid.
  const dominant = [...input.languageCoverage].sort((a, b) => b.share - a.share)[0];
  if (dominant && TS_FAMILY.has(dominant.language.toLowerCase()) && dominant.share < 0.9) {
    return {
      backend: "hybrid",
      reason: `TS-dominant (${Math.round(dominant.share * 100)}%) with non-TS subtrees; fallow on TS, desloppify on the rest`,
    };
  }

  return {
    backend: "supi-native",
    reason: "no clear backend match; defer to manual lint/dupe per stack",
  };
}
