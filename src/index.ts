import { detectPlatform } from "./platform/detect.js";
import { createOmpAdapter } from "./platform/omp.js";
import { createPiAdapter } from "./platform/pi.js";
import { bootstrap } from "./bootstrap.js";

export default function supipowers(rawApi: any): void {
  const platformType = detectPlatform(rawApi);
  const platform = platformType === "omp"
    ? createOmpAdapter(rawApi)
    : createPiAdapter(rawApi);

  bootstrap(platform);
}
