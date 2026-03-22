// src/platform/detect.ts
export type PlatformType = "pi" | "omp";

export function detectPlatform(rawApi: any): PlatformType {
  if (rawApi.pi && typeof rawApi.pi.createAgentSession === "function") {
    return "omp";
  }
  return "pi";
}
