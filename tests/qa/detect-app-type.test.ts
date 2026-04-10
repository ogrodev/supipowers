import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectAppType } from "../../src/qa/detect-app-type";

describe("detectAppType", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Next.js App Router — next.config.js + app/ dir", () => {
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), "");
    fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("nextjs-app");
    expect(result.port).toBe(3000);
  });

  test("Next.js Pages Router — next.config.js + pages/ dir, no app/", () => {
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), "");
    fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("nextjs-pages");
  });

  test("Next.js src/app — next.config.ts + src/app/ dir", () => {
    fs.writeFileSync(path.join(tmpDir, "next.config.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("nextjs-app");
  });

  test("Next.js App Router — app/ dir without next.config is still detected", () => {
    fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("nextjs-app");
  });

  test("Next.js Pages Router — pages/ dir without next.config is still detected", () => {
    fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("nextjs-pages");
  });

  test("Vite — vite.config.ts present", () => {
    fs.writeFileSync(path.join(tmpDir, "vite.config.ts"), "");

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("vite");
    expect(result.port).toBe(5173);
  });

  test("Angular — angular.json present", () => {
    fs.writeFileSync(path.join(tmpDir, "angular.json"), "");

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("generic");
    expect(result.devCommand).toBe("npm start");
    expect(result.port).toBe(4200);
  });

  test("Express — package.json with express in deps", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.18.0" } }),
    );

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("express");
  });

  test("Generic fallback — empty dir", () => {
    const result = detectAppType(tmpDir);
    expect(result.type).toBe("generic");
    expect(result.devCommand).toBe("npm run dev");
    expect(result.port).toBe(3000);
  });

  test("Dev command override — scripts.start present but no scripts.dev", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } }),
    );

    const result = detectAppType(tmpDir);
    expect(result.devCommand).toBe("npm start");
  });

  test("Port extraction --port flag", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev --port 4000" } }),
    );

    const result = detectAppType(tmpDir);
    expect(result.port).toBe(4000);
  });

  test("Port extraction PORT= env var", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "PORT=8080 node server.js" } }),
    );

    const result = detectAppType(tmpDir);
    expect(result.port).toBe(8080);
  });

  test("baseUrl is always http://localhost:${port}", () => {
    fs.writeFileSync(path.join(tmpDir, "vite.config.ts"), "");

    const result = detectAppType(tmpDir);
    expect(result.baseUrl).toBe(`http://localhost:${result.port}`);
    expect(result.baseUrl).toBe("http://localhost:5173");
  });

  test("Invalid package.json — returns defaults, no throw", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "NOT VALID JSON {{{");

    const result = detectAppType(tmpDir);
    expect(result.type).toBe("generic");
    expect(result.devCommand).toBe("npm run dev");
    expect(result.port).toBe(3000);
    expect(result.baseUrl).toBe("http://localhost:3000");
  });
});
