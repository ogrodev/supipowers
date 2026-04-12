# Extension Structure & Loading

## Table of Contents
- [Single-File Extension](#single-file-extension)
- [Directory Extension](#directory-extension)
- [Package.json Manifest](#packagejson-manifest)
- [Discovery Locations](#discovery-locations)
- [Entry File Resolution](#entry-file-resolution)
- [Enable/Disable Controls](#enabledisable-controls)
- [Complete Example: Directory Extension](#complete-example-directory-extension)

---

## Single-File Extension

The simplest form — a single TypeScript file with a default-exported factory function:

```typescript
// ~/.omp/agent/extensions/my-ext.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.setLabel("My Extension");

  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello from my extension!", "info");
    },
  });
}
```

Drop this file in any discovery location and it will be loaded automatically.

## Directory Extension

For extensions that need dependencies, multiple source files, or a more organized structure:

```
my-extension/
├── package.json          # declares entry points and dependencies
├── tsconfig.json         # optional — Bun handles TS natively
├── src/
│   ├── index.ts          # main entry point
│   ├── commands/
│   │   ├── review.ts
│   │   └── config.ts
│   └── utils/
│       └── git.ts
└── node_modules/         # npm/bun dependencies
```

## Package.json Manifest

The `omp` field declares extension entry points:

```json
{
  "name": "my-omp-extension",
  "version": "1.0.0",
  "type": "module",
  "omp": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": "^13"
  },
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "latest"
  }
}
```

**Key points:**
- `"type": "module"` — extensions use ESM. Import paths should use `.js` extensions (e.g., `import { foo } from "./utils.js"`) for Bun compatibility
- `omp.extensions` is an array — you can declare multiple entry files (each becomes a separate extension)
- `@oh-my-pi/pi-coding-agent` should be a **peer dependency** (the host provides it at runtime). Use `"^13"` to pin to a major version, or `"*"` for maximum compatibility
- Add it as a dev dependency too for type checking during development
- If your extension uses custom TUI rendering (widgets, custom renderers), also add `@oh-my-pi/pi-tui` as a peer dependency
- The legacy `"pi"` field is also supported for backward compatibility
- Bun handles TypeScript natively — no build step needed. A `tsconfig.json` is still recommended for IDE type-checking (`tsc --noEmit`)

## Discovery Locations

Extensions are auto-discovered from these directories (no configuration needed):

| Location | Scope |
|---|---|
| `<cwd>/.omp/extensions/` | Project-level (repo-specific) |
| `~/.omp/agent/extensions/` | User-level (global, all projects) |

### Configured Paths (explicit)

You can also register extensions explicitly:

**CLI flag:**
```bash
omp --extension ./path/to/ext.ts
omp -e ./path/to/ext.ts
omp --hook ./path/to/ext.ts    # --hook is aliased to --extension
```

**Global config** (`~/.omp/agent/config.yml`):
```yaml
extensions:
  - ~/my-extensions/safety.ts
  - ~/my-extensions/review-pack
```

**Project config** (`<cwd>/.omp/settings.json`):
```json
{
  "extensions": ["./.omp/extensions/my-extra"]
}
```

### Cross-Tool Compatibility

OMP also discovers extensions from other tool directories:
- `~/.claude/` and `.claude/`
- `~/.codex/` and `.codex/`
- `~/.cursor/`, `~/.windsurf/`, `~/.cline/`
- `~/.github/copilot/`

## Entry File Resolution

When a directory path is given as an extension, OMP resolves the entry point in this order:

1. **package.json** with `omp.extensions` (or legacy `pi.extensions`) → use declared entries
2. **index.ts** in the directory root
3. **index.js** in the directory root
4. **Scan one level deep** for:
   - Direct `.ts` / `.js` files
   - Subdirectory `index.ts` / `index.js`
   - Subdirectory `package.json` with `omp.extensions`

This means a flat structure like `extensions/my-tool.ts` works, and so does `extensions/my-tool/index.ts`.

## Enable/Disable Controls

### Disable all extensions
```bash
omp --no-extensions
```
Or in the SDK:
```typescript
createAgentSession({ disableExtensionDiscovery: true });
```

### Disable specific extensions

In settings (`config.yml` or `settings.json`):
```yaml
disabledExtensions:
  - extension-module:my-ext    # derived from path: /x/my-ext.ts → "my-ext"
```

### Interactive management

The `/extensions` (or `/status`) built-in command opens the Extension Control Center — an interactive TUI dashboard where you can enable/disable extensions at runtime.

---

## Complete Example: Directory Extension

This example shows a complete directory-based extension that tracks deployment status:

**`deploy-tracker/package.json`:**
```json
{
  "name": "deploy-tracker",
  "version": "1.0.0",
  "omp": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": "^13"
  },
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "latest"
  },
  "dependencies": {
    "yaml": "^2.3.0"
  }
}
```

**`deploy-tracker/src/index.ts`:**
```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parse } from "yaml";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export default function deployTracker(pi: ExtensionAPI) {
  pi.setLabel("Deploy Tracker");

  // Pure UI command — show deployment status from local file
  pi.registerCommand("deploys", {
    description: "Show recent deployments",
    async handler(_args, ctx) {
      const statusFile = join(ctx.cwd, ".deploy-status.yml");
      if (!existsSync(statusFile)) {
        ctx.ui.notify("No deployments tracked yet", "info");
        return;
      }

      const data = parse(readFileSync(statusFile, "utf8"));
      const entries = data.deployments.map(
        (d: any) => `${d.env} — ${d.version} (${d.timestamp})`
      );
      entries.push("Close");

      await ctx.ui.select("Recent Deployments", entries, {
        helpText: "Esc to close",
      });
      // Returns void — no LLM involvement
    },
  });

  // Notify on session start if there's a pending deployment
  pi.on("session_start", async (_event, ctx) => {
    const statusFile = join(ctx.cwd, ".deploy-status.yml");
    if (!existsSync(statusFile)) return;

    const data = parse(readFileSync(statusFile, "utf8"));
    const pending = data.deployments?.find((d: any) => d.status === "pending");
    if (pending) {
      ctx.ui.notify(`Pending deploy: ${pending.env} v${pending.version}`, "warning");
    }
  });
}
```

Install dependencies and place in a discovery location:
```bash
cd deploy-tracker && bun install
# Copy to user extensions:
cp -r deploy-tracker ~/.omp/agent/extensions/
# Or symlink for development:
ln -s $(pwd)/deploy-tracker ~/.omp/agent/extensions/deploy-tracker
```
