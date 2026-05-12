import { describe, expect, test } from "bun:test";

import {
  computeLayerSourceHash,
  type ComputeLayerSourceHashInput,
} from "../../../src/harness/docs/source-hash.js";
import type { HarnessLayerRule } from "../../../src/types.js";

function baseInput(): ComputeLayerSourceHashInput {
  const layerRule: HarnessLayerRule = {
    layer: "lib",
    globs: ["src/lib/**"],
    allowedImports: [],
    forbiddenImports: ["app"],
    description: "Independent library code.",
  };
  return {
    layerRule,
    globPaths: ["src/lib/a.ts", "src/lib/b.ts"],
    representativeFiles: [
      { path: "src/lib/a.ts", contentHash: "hash-a" },
      { path: "src/lib/b.ts", contentHash: "hash-b" },
    ],
    goldenPrinciples: ["Principle 1", "Principle 2"],
    peerLayers: [{ id: "app", description: "App layer" }],
    promptVersion: "prompt-v1",
  };
}

describe("computeLayerSourceHash", () => {
  test("same inputs produce same hash", () => {
    const a = computeLayerSourceHash(baseInput());
    const b = computeLayerSourceHash(baseInput());
    expect(a).toBe(b);
  });

  test("reordered globPaths produce the same hash", () => {
    const a = computeLayerSourceHash(baseInput());
    const swapped = baseInput();
    swapped.globPaths = ["src/lib/b.ts", "src/lib/a.ts"];
    const b = computeLayerSourceHash(swapped);
    expect(a).toBe(b);
  });

  test("reordered representative files produce the same hash", () => {
    const a = computeLayerSourceHash(baseInput());
    const swapped = baseInput();
    swapped.representativeFiles = [
      { path: "src/lib/b.ts", contentHash: "hash-b" },
      { path: "src/lib/a.ts", contentHash: "hash-a" },
    ];
    const b = computeLayerSourceHash(swapped);
    expect(a).toBe(b);
  });

  test("reordered peer layers produce the same hash", () => {
    const a = computeLayerSourceHash({
      ...baseInput(),
      peerLayers: [
        { id: "app", description: "App layer" },
        { id: "infra", description: "Infrastructure" },
      ],
    });
    const b = computeLayerSourceHash({
      ...baseInput(),
      peerLayers: [
        { id: "infra", description: "Infrastructure" },
        { id: "app", description: "App layer" },
      ],
    });
    expect(a).toBe(b);
  });

  test("representative file content change shifts the hash", () => {
    const a = computeLayerSourceHash(baseInput());
    const changed = baseInput();
    changed.representativeFiles = [
      { path: "src/lib/a.ts", contentHash: "hash-a-new" },
      { path: "src/lib/b.ts", contentHash: "hash-b" },
    ];
    const b = computeLayerSourceHash(changed);
    expect(a).not.toBe(b);
  });

  test("adding a non-representative file path changes the hash", () => {
    // glob paths are full list; even adding a file that didn't make the top-N rep set
    // should invalidate (file count and listing matter).
    const a = computeLayerSourceHash(baseInput());
    const changed = baseInput();
    changed.globPaths = [...changed.globPaths, "src/lib/c.ts"];
    const b = computeLayerSourceHash(changed);
    expect(a).not.toBe(b);
  });

  test("layer rule change shifts the hash", () => {
    const a = computeLayerSourceHash(baseInput());
    const changed = baseInput();
    changed.layerRule = {
      ...changed.layerRule,
      forbiddenImports: ["app", "infra"],
    };
    const b = computeLayerSourceHash(changed);
    expect(a).not.toBe(b);
  });

  test("rule description change shifts the hash", () => {
    const a = computeLayerSourceHash(baseInput());
    const changed = baseInput();
    changed.layerRule = { ...changed.layerRule, description: "Different description." };
    const b = computeLayerSourceHash(changed);
    expect(a).not.toBe(b);
  });

  test("rule with no description matches another with description empty string", () => {
    const a = computeLayerSourceHash({
      ...baseInput(),
      layerRule: {
        layer: "lib",
        globs: ["src/lib/**"],
        allowedImports: [],
        forbiddenImports: ["app"],
      },
    });
    const b = computeLayerSourceHash({
      ...baseInput(),
      layerRule: {
        layer: "lib",
        globs: ["src/lib/**"],
        allowedImports: [],
        forbiddenImports: ["app"],
        description: "",
      },
    });
    expect(a).toBe(b);
  });

  test("prompt version change shifts the hash", () => {
    const a = computeLayerSourceHash(baseInput());
    const changed = baseInput();
    changed.promptVersion = "prompt-v2";
    const b = computeLayerSourceHash(changed);
    expect(a).not.toBe(b);
  });

  test("hash is a 64-char hex string", () => {
    const a = computeLayerSourceHash(baseInput());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
