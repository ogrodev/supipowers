// src/context-mode/tool-name.ts
//
// OMP 14.3.0 renamed `read` to `open` at the wire level while keeping `read`
// as a legacy alias. Internally we keep using the historical `read` key so
// every dispatch site only has to learn one name. Apply this normalizer to
// the raw `tool_call`/`tool_result` `toolName` before any switch.

/** Map an OMP tool name to its canonical internal key. */
export function canonicalToolName(name: string): string {
  return name === "open" ? "read" : name;
}
