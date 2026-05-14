---
description: "Agent Client Protocol reference for OMP/ACP adapters, JSON-RPC sessions, prompts, updates, permissions, filesystem, and terminal methods."
---
# ACP

Load when implementing or debugging ACP agent/client code.

Key guidance:
- Treat ACP as JSON-RPC 2.0 over stdio; preserve request IDs, method names, and error shapes exactly.
- Keep session lifecycle explicit: create session, send prompt, emit updates, request permissions, then close/complete.
- Model filesystem and terminal operations as protocol capabilities; do not bypass negotiated permissions.
- Validate inbound payloads as `unknown` before narrowing to shared TypeScript types.
- Add protocol-level tests for success, denial, malformed payloads, and cancellation paths.
