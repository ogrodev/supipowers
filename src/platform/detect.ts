// src/platform/detect.ts
export function detectPlatform(rawApi: any): "omp" {
  if (!rawApi.pi || typeof rawApi.pi.createAgentSession !== "function") {
    throw new Error("Unrecognized API shape — expected OMP ExtensionAPI");
  }
  return "omp";
}
