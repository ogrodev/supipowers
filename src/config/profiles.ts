// src/config/profiles.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { Profile, SupipowersConfig } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";
import { BUILTIN_PROFILES } from "./defaults.js";

function getProfilesDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "profiles");
}

/** Load a profile by name. Checks project dir first, then built-ins. */
export function loadProfile(paths: PlatformPaths, cwd: string, name: string): Profile | null {
  // Check project-level custom profiles
  const customPath = path.join(getProfilesDir(paths, cwd), `${name}.json`);
  if (fs.existsSync(customPath)) {
    try {
      return JSON.parse(fs.readFileSync(customPath, "utf-8")) as Profile;
    } catch {
      // fall through to built-in
    }
  }
  return BUILTIN_PROFILES[name] ?? null;
}

/** Resolve the active profile from config, with optional override */
export function resolveProfile(
  paths: PlatformPaths,
  cwd: string,
  config: SupipowersConfig,
  override?: string
): Profile {
  const name = override ?? config.defaultProfile;
  const profile = loadProfile(paths, cwd, name);
  if (!profile) {
    // Fallback to thorough if configured profile doesn't exist
    return BUILTIN_PROFILES["thorough"];
  }
  return profile;
}

/** List all available profiles (built-in + custom) */
export function listProfiles(paths: PlatformPaths, cwd: string): string[] {
  const names = new Set(Object.keys(BUILTIN_PROFILES));
  const dir = getProfilesDir(paths, cwd);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".json")) {
        names.add(file.replace(".json", ""));
      }
    }
  }
  return [...names].sort();
}

/** Save a custom profile */
export function saveProfile(paths: PlatformPaths, cwd: string, profile: Profile): void {
  const dir = getProfilesDir(paths, cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${profile.name}.json`),
    JSON.stringify(profile, null, 2) + "\n"
  );
}
