import * as fs from "node:fs";
import * as path from "node:path";

export interface DiscoveredRoute {
  path: string;
  file: string;
  type: "page" | "api" | "auth";
  hasForm: boolean;
  methods?: string[];
}

const CODE_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

const FORM_PATTERNS =
  /<form|onSubmit|handleSubmit|useForm|formik|react-hook-form/;

const HTTP_METHODS_RE = /\b(GET|POST|PUT|PATCH|DELETE)\b/g;

/**
 * Recursively walk `dir`, returning relative file paths whose extension
 * is in `extensions`. All returned paths use forward slashes.
 */
function walkDir(dir: string, extensions: string[]): string[] {
  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  const extSet = new Set(extensions);

  function recurse(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile() && extSet.has(path.extname(entry.name))) {
        results.push(path.relative(dir, full).replace(/\\/g, "/"));
      }
    }
  }

  recurse(dir);
  return results;
}

/** Try to read file content; return empty string on failure. */
function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function hasForm(content: string): boolean {
  return FORM_PATTERNS.test(content);
}

function extractHttpMethods(content: string): string[] {
  const matches = content.match(HTTP_METHODS_RE);
  if (!matches || matches.length === 0) return ["GET"];
  return [...new Set(matches)];
}

// ────────────────────────────────────────────────
// Framework scanners
// ────────────────────────────────────────────────

function scanNextjsApp(cwd: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const prefix of ["app", "src/app"]) {
    const dir = path.join(cwd, prefix);
    if (!fs.existsSync(dir)) continue;

    const files = walkDir(dir, CODE_EXTENSIONS);

    for (const rel of files) {
      const basename = path.basename(rel);
      const fullPath = path.join(dir, rel).replace(/\\/g, "/");

      // page files → page routes
      if (/^page\.(tsx|jsx|ts|js)$/.test(basename)) {
        const routePath = rel.replace(/(^|\/)page\.\w+$/, "");
        let route = routePath ? "/" + routePath : "/";
        // strip route groups: /(groupname)
        route = route.replace(/\/\([^)]*\)/g, "");
        if (route === "" || route === "/") {
          route = "/";
        }
        // normalize double slashes
        route = route.replace(/\/+/g, "/");

        const content = safeRead(path.join(dir, rel));
        routes.push({
          path: route,
          file: (prefix + "/" + rel).replace(/\\/g, "/"),
          type: "page",
          hasForm: hasForm(content),
        });
      }

      // route files → API routes
      if (/^route\.(tsx|ts|js)$/.test(basename)) {
        const route = "/" + rel.replace(/\/route\.\w+$/, "");
        const content = safeRead(path.join(dir, rel));
        const methods = extractHttpMethods(content);

        routes.push({
          path: route.replace(/\/+/g, "/"),
          file: (prefix + "/" + rel).replace(/\\/g, "/"),
          type: "api",
          hasForm: false,
          methods,
        });
      }
    }
  }

  return routes;
}

function scanNextjsPages(cwd: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const SKIP_BASENAMES = /^_(app|document|error)\./;

  for (const prefix of ["pages", "src/pages"]) {
    const dir = path.join(cwd, prefix);
    if (!fs.existsSync(dir)) continue;

    const files = walkDir(dir, CODE_EXTENSIONS);

    for (const rel of files) {
      const basename = path.basename(rel);
      if (SKIP_BASENAMES.test(basename)) continue;

      const filePath = (prefix + "/" + rel).replace(/\\/g, "/");
      const fullDisk = path.join(dir, rel);

      // Strip extension, then replace /index with /
      const routePath = rel
        .replace(/\.(tsx|jsx|ts|js)$/, "")
        .replace(/(^|\/)index$/, "");
      let route = routePath ? "/" + routePath : "/";
      if (route === "/" || route === "") route = "/";
      route = route.replace(/\/+/g, "/");

      if (rel.includes("api/")) {
        const content = safeRead(fullDisk);
        const methods = extractHttpMethods(content);
        routes.push({
          path: route,
          file: filePath,
          type: "api",
          hasForm: false,
          methods,
        });
      } else {
        const content = safeRead(fullDisk);
        routes.push({
          path: route,
          file: filePath,
          type: "page",
          hasForm: hasForm(content),
        });
      }
    }
  }

  return routes;
}

function scanReactRouter(cwd: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const srcDir = path.join(cwd, "src");
  if (!fs.existsSync(srcDir)) return routes;

  const files = walkDir(srcDir, CODE_EXTENSIONS);

  for (const rel of files) {
    const fullDisk = path.join(srcDir, rel);
    const content = safeRead(fullDisk);
    if (!content) continue;

    if (!/<Route|createBrowserRouter|useRoutes/.test(content)) continue;

    const filePath = ("src/" + rel).replace(/\\/g, "/");

    // Extract path="..." and path: '...' patterns
    const pathMatches = content.matchAll(/path[=:]\s*["']([^"']+)["']/g);
    for (const m of pathMatches) {
      const routePath = m[1];
      if (!routePath) continue;
      routes.push({
        path: routePath,
        file: filePath,
        type: "page",
        hasForm: hasForm(content),
      });
    }
  }

  return routes;
}

function scanExpress(cwd: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const EXPRESS_RE =
    /\.(get|post|put|patch|delete)\s*\(\s*["'](\/?[^"']*)["']/gi;

  for (const dirName of ["src", "routes", "server"]) {
    const dir = path.join(cwd, dirName);
    if (!fs.existsSync(dir)) continue;

    const files = walkDir(dir, [".ts", ".js"]);

    for (const rel of files) {
      const fullDisk = path.join(dir, rel);
      const content = safeRead(fullDisk);
      if (!content) continue;

      const matches = content.matchAll(EXPRESS_RE);
      for (const m of matches) {
        let method = m[1].toUpperCase();
        const routePath = m[2];
        if (!routePath || !routePath.startsWith("/")) continue;

        routes.push({
          path: routePath,
          file: (dirName + "/" + rel).replace(/\\/g, "/"),
          type: "api",
          hasForm: false,
          methods: [method],
        });
      }
    }
  }

  return routes;
}

function scanGeneric(cwd: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const srcDir = path.join(cwd, "src");
  if (!fs.existsSync(srcDir)) return routes;

  const files = walkDir(srcDir, CODE_EXTENSIONS);

  for (const rel of files) {
    const fullDisk = path.join(srcDir, rel);
    const content = safeRead(fullDisk);
    if (!content) continue;

    if (!/<Route|createBrowserRouter|useRoutes/.test(content)) continue;

    const filePath = ("src/" + rel).replace(/\\/g, "/");

    const pathMatches = content.matchAll(/path[=:]\s*["']([^"']+)["']/g);
    for (const m of pathMatches) {
      const routePath = m[1];
      if (!routePath) continue;
      routes.push({
        path: routePath,
        file: filePath,
        type: "page",
        hasForm: hasForm(content),
      });
    }
  }

  return routes;
}

// ────────────────────────────────────────────────
// Auth scan (runs for all framework types)
// ────────────────────────────────────────────────

const AUTH_FILENAME_RE = /(auth|login|signup|register)/i;
const AUTH_EXCLUDE_RE = /(node_modules|\.next|\.test\.|\.spec\.)/;

function scanAuth(cwd: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const srcDir = path.join(cwd, "src");
  if (!fs.existsSync(srcDir)) return routes;

  const files = walkDir(srcDir, CODE_EXTENSIONS);

  for (const rel of files) {
    const fullRel = "src/" + rel;

    // Exclude node_modules, .next, test/spec files
    if (AUTH_EXCLUDE_RE.test(fullRel)) continue;

    const basename = path.basename(rel);
    if (!AUTH_FILENAME_RE.test(basename)) continue;

    const fullDisk = path.join(srcDir, rel);
    const content = safeRead(fullDisk);

    // Route hint from filename without extension
    const nameWithoutExt = basename.replace(/\.(tsx|jsx|ts|js)$/, "");

    routes.push({
      path: "/" + nameWithoutExt,
      file: fullRel.replace(/\\/g, "/"),
      type: "auth",
      hasForm: hasForm(content),
    });
  }

  return routes;
}

// ────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────

export function discoverRoutes(
  cwd: string,
  appType: string,
): DiscoveredRoute[] {
  let routes: DiscoveredRoute[];

  switch (appType) {
    case "nextjs-app":
      routes = scanNextjsApp(cwd);
      break;
    case "nextjs-pages":
      routes = scanNextjsPages(cwd);
      break;
    case "react-router":
      routes = scanReactRouter(cwd);
      break;
    case "express":
      routes = scanExpress(cwd);
      break;
    case "vite":
    case "generic":
    default:
      routes = scanGeneric(cwd);
      break;
  }

  // Auth scan always runs
  routes.push(...scanAuth(cwd));

  return routes;
}
