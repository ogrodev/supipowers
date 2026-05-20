# Platform-Specific Dependencies

## Platform-Specific Dependencies

```json
// package.json
{
  "name": "my-app",
  "dependencies": {
    "common-dep": "^1.0.0"
  },
  "optionalDependencies": {
    "fsevents": "^2.3.2"
  },
  "devDependencies": {
    "@types/node": "^18.0.0"
  }
}
```

```typescript
// platform-specific-module.ts
export async function loadPlatformModule() {
  if (process.platform === "win32") {
    return await import("./windows/module");
  } else if (process.platform === "darwin") {
    return await import("./macos/module");
  } else {
    return await import("./linux/module");
  }
}

// Graceful fallback for optional dependencies. Uses dynamic `import()` so the
// example works under ESM (`"type": "module"`) and degrades to native
// `fs.watch` when neither `fsevents` nor `chokidar` is installed.
export async function useFSEvents() {
  try {
    // fsevents is macOS only
    if (process.platform === "darwin") {
      return await import("fsevents");
    }
  } catch (error) {
    console.warn("fsevents not available, using fallback");
  }

  // Fallback to chokidar, then to native fs.watch as a final safety net.
  try {
    return await import("chokidar");
  } catch {
    const { watch } = await import("node:fs/promises");
    return { watch };
  }
}
```
