import { createOmpAdapter } from "./platform/omp.js";
import { bootstrap } from "./bootstrap.js";

export default function supipowers(rawApi: any): void {
  const platform = createOmpAdapter(rawApi);
  bootstrap(platform);
}
