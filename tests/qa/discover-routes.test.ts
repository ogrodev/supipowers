import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverRoutes } from "../../src/qa/discover-routes";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a file inside tmpDir, ensuring parent dirs exist. */
function fixture(rel: string, content = ""): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

// ─── nextjs-app ──────────────────────────────────────────

describe("nextjs-app", () => {
  test("app/page.tsx is discovered as a page", () => {
    fixture("app/page.tsx", "export default function Home() { return <div/>; }");
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const page = routes.find((r) => r.type === "page" && r.file === "app/page.tsx");
    expect(page).toBeDefined();
    expect(page!.type).toBe("page");
  });

  test("app/login/page.tsx → route '/login'", () => {
    fixture("app/login/page.tsx", "export default function Login() {}");
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const page = routes.find((r) => r.path === "/login");
    expect(page).toBeDefined();
    expect(page!.file).toBe("app/login/page.tsx");
  });

  test("route groups stripped: app/(auth)/login/page.tsx → '/login'", () => {
    fixture("app/(auth)/login/page.tsx", "export default function Login() {}");
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const page = routes.find((r) => r.type === "page" && r.path === "/login");
    expect(page).toBeDefined();
    expect(page!.file).toBe("app/(auth)/login/page.tsx");
  });

  test("api route with exported GET method", () => {
    fixture(
      "app/api/users/route.ts",
      "export async function GET(req: Request) { return Response.json([]); }",
    );
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const api = routes.find((r) => r.type === "api" && r.path === "/api/users");
    expect(api).toBeDefined();
    expect(api!.methods).toContain("GET");
    expect(api!.hasForm).toBe(false);
  });

  test("src/app/ prefix is also scanned", () => {
    fixture("src/app/dashboard/page.tsx", "export default function Dash() {}");
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const page = routes.find((r) => r.type === "page" && r.file === "src/app/dashboard/page.tsx");
    expect(page).toBeDefined();
    expect(page!.path).toBe("/dashboard");
  });
});

// ─── nextjs-pages ────────────────────────────────────────

describe("nextjs-pages", () => {
  test("pages/index.tsx is discovered as a page", () => {
    fixture("pages/index.tsx", "export default function Index() {}");
    const routes = discoverRoutes(tmpDir, "nextjs-pages");
    const page = routes.find((r) => r.type === "page" && r.file === "pages/index.tsx");
    expect(page).toBeDefined();
  });

  test("pages/about.tsx → route '/about'", () => {
    fixture("pages/about.tsx", "export default function About() {}");
    const routes = discoverRoutes(tmpDir, "nextjs-pages");
    const page = routes.find((r) => r.path === "/about");
    expect(page).toBeDefined();
    expect(page!.type).toBe("page");
  });

  test("pages/_app.tsx is skipped", () => {
    fixture("pages/_app.tsx", "export default function App() {}");
    const routes = discoverRoutes(tmpDir, "nextjs-pages");
    expect(routes.find((r) => r.file === "pages/_app.tsx")).toBeUndefined();
  });

  test("pages/api/hello.ts → type api with methods", () => {
    fixture(
      "pages/api/hello.ts",
      "export function POST(req, res) { res.status(200).json({}); }",
    );
    const routes = discoverRoutes(tmpDir, "nextjs-pages");
    const api = routes.find((r) => r.type === "api");
    expect(api).toBeDefined();
    expect(api!.methods).toContain("POST");
  });
});

// ─── form detection ──────────────────────────────────────

describe("form detection", () => {
  test("file with <form → hasForm true", () => {
    fixture(
      "app/contact/page.tsx",
      '<form action="/send"><input name="email"/></form>',
    );
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const page = routes.find((r) => r.path === "/contact");
    expect(page).toBeDefined();
    expect(page!.hasForm).toBe(true);
  });

  test("file with onSubmit → hasForm true", () => {
    fixture(
      "app/feedback/page.tsx",
      "export default function F() { return <div onSubmit={handle}>ok</div>; }",
    );
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const page = routes.find((r) => r.path === "/feedback");
    expect(page!.hasForm).toBe(true);
  });

  test("file with no form patterns → hasForm false", () => {
    fixture(
      "app/about/page.tsx",
      "export default function About() { return <h1>About</h1>; }",
    );
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const page = routes.find((r) => r.path === "/about");
    expect(page!.hasForm).toBe(false);
  });
});

// ─── auth scan ───────────────────────────────────────────

describe("auth scan", () => {
  test("src/auth.tsx detected as auth type", () => {
    fixture("src/auth.tsx", "export function AuthProvider() {}");
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const auth = routes.find((r) => r.type === "auth");
    expect(auth).toBeDefined();
    expect(auth!.file).toBe("src/auth.tsx");
  });

  test("src/components/login-form.tsx detected as auth type", () => {
    fixture(
      "src/components/login-form.tsx",
      '<form onSubmit={handleLogin}><input/></form>',
    );
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const auth = routes.find(
      (r) => r.type === "auth" && r.file === "src/components/login-form.tsx",
    );
    expect(auth).toBeDefined();
    expect(auth!.hasForm).toBe(true);
  });

  test("test files excluded from auth scan", () => {
    fixture("src/utils/auth.test.ts", "test('auth works', () => {});");
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    const match = routes.find(
      (r) => r.type === "auth" && r.file.includes("auth.test"),
    );
    expect(match).toBeUndefined();
  });
});

// ─── empty / missing ─────────────────────────────────────

describe("empty / missing", () => {
  test("empty dir with nextjs-app → empty array", () => {
    const routes = discoverRoutes(tmpDir, "nextjs-app");
    expect(routes).toEqual([]);
  });

  test("generic with no src/ → empty array", () => {
    const routes = discoverRoutes(tmpDir, "generic");
    expect(routes).toEqual([]);
  });
});
