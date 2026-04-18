// tests/evals/context-mode-routes-large-output.test.ts
//
// How to break it: remove the `grep`, `fetch`/`web_fetch`, or bash HTTP
// branches from routeToolCall — this eval asserts each still returns a block
// result pointing at a ctx_* tool. Also breaks if allow-list prefixes such as
// `git` stop being honored (git status should remain unblocked).
import { expect } from "bun:test";
import { defineEval } from "./harness.js";
import {
  routeToolCall,
  type BlockResult,
} from "../../src/context-mode/routing.js";
import {
  detectContextMode,
  type ContextModeStatus,
} from "../../src/context-mode/detector.js";

// Regression class: context-mode silently stops enforcing ctx_* tools.
defineEval({
  name: "context-mode-routes-large-output",
  summary:
    "context-mode blocks grep/find, bash HTTP, and WebFetch with a reason pointing to ctx_* tools",
  regressionClass: "context-mode silently stops enforcing ctx_* tools",
  run: () => {
    const status: ContextModeStatus = detectContextMode([
      "ctx_execute",
      "ctx_search",
      "ctx_batch_execute",
    ]);
    const opts = { enforceRouting: true, blockHttpCommands: true };

    const expectBlocked = (r: BlockResult | undefined): BlockResult => {
      expect(r).toBeDefined();
      expect(r!.block).toBe(true);
      return r!;
    };

    // a) grep → blocked, reason mentions ctx_search or ctx_batch_execute
    const grepResult = expectBlocked(
      routeToolCall("grep", { pattern: "TODO" }, status, opts),
    );
    expect(grepResult.reason).toMatch(/ctx_search|ctx_batch_execute/);

    // find → blocked, reason mentions ctx_execute or ctx_batch_execute
    const findResult = expectBlocked(
      routeToolCall("find", { pattern: "*.ts" }, status, opts),
    );
    expect(findResult.reason).toMatch(/ctx_execute|ctx_batch_execute/);

    // b) bash with curl https://... → blocked, reason mentions ctx_fetch_and_index
    const curlResult = expectBlocked(
      routeToolCall(
        "bash",
        { command: "curl https://example.com" },
        status,
        opts,
      ),
    );
    expect(curlResult.reason).toMatch(/ctx_fetch_and_index/);

    // wget is also blocked
    expectBlocked(
      routeToolCall(
        "bash",
        { command: "wget https://example.com/file" },
        status,
        opts,
      ),
    );

    // bash with inline grep → treated as search, routed to ctx_execute
    const bashGrepResult = expectBlocked(
      routeToolCall("bash", { command: "grep -rn TODO src/" }, status, opts),
    );
    expect(bashGrepResult.reason).toMatch(/ctx_execute|ctx_batch_execute/);

    // WebFetch / fetch tool → blocked, reason mentions ctx_fetch_and_index
    const fetchResult = expectBlocked(
      routeToolCall(
        "fetch",
        { url: "https://example.com" },
        status,
        opts,
      ),
    );
    expect(fetchResult.reason).toMatch(/ctx_fetch_and_index/);
    const webFetchResult = expectBlocked(
      routeToolCall(
        "web_fetch",
        { url: "https://example.com" },
        status,
        opts,
      ),
    );
    expect(webFetchResult.reason).toMatch(/ctx_fetch_and_index/);

    // c) bash with an allow-listed prefix (`git status`) must pass through.
    expect(
      routeToolCall("bash", { command: "git status" }, status, opts),
    ).toBeUndefined();
    // Same for `ls -la` and `npm install` (allow-listed).
    expect(
      routeToolCall("bash", { command: "ls -la" }, status, opts),
    ).toBeUndefined();
    expect(
      routeToolCall("bash", { command: "npm install" }, status, opts),
    ).toBeUndefined();

    // d) Read tool: current production behavior is that the native `read`
    // tool is NOT routed by routeToolCall — anchors must be preserved for the
    // edit contract, and large reads are auto-compressed by the read tool
    // itself. So a full-file-style Read input is ALLOWED (no block result).
    expect(
      routeToolCall("read", { path: "src/big.ts" }, status, opts),
    ).toBeUndefined();
    expect(
      routeToolCall(
        "read",
        { path: "src/big.ts", limit: 50 },
        status,
        opts,
      ),
    ).toBeUndefined();

    // Sanity: enforcement flag actually gates grep routing.
    expect(
      routeToolCall("grep", { pattern: "TODO" }, status, {
        enforceRouting: false,
        blockHttpCommands: true,
      }),
    ).toBeUndefined();
    // And blockHttpCommands gates bash HTTP routing.
    expect(
      routeToolCall(
        "bash",
        { command: "curl https://example.com" },
        status,
        { enforceRouting: true, blockHttpCommands: false },
      ),
    ).toBeUndefined();
  },
});
