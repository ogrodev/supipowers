# Build Configuration

## Build Configuration

```typescript
// rollup.config.js
import replace from "@rollup/plugin-replace";
export default {
  input: "src/index.ts",
  output: [
    {
      file: "dist/index.js",
      format: "cjs",
    },
    {
      file: "dist/index.esm.js",
      format: "esm",
    },
  ],
  external: [
    // Mark platform-specific modules as external
    "fsevents",
  ],
  plugins: [
    // ⚠️  WARNING: Inlines the build machine's `process.platform` at build time.
    // Only use when emitting separate platform-specific artifacts (per-target
    // build pipeline). For a single cross-platform bundle, remove this plugin
    // and rely on runtime `process.platform` checks instead.
    replace({
      "process.platform": JSON.stringify(process.platform),
      preventAssignment: true,
    }),
  ],
};
```
