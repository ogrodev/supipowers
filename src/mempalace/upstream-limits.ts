/**
 * Upstream MemPalace pin.
 *
 * Single source of truth for the `mempalace` PyPI package version and
 * the parameter limits the upstream package enforces. Keeping these in
 * one place — instead of sprinkling `"3.3.4"` / `500` / `100` / `128`
 * magic literals across the config defaults, schema, hooks, and tests —
 * makes a version bump a one-line edit and guarantees our tool surface
 * advertises the same bounds the upstream MCP server enforces.
 *
 * # Bump procedure
 * 1. Update `MEMPALACE_PACKAGE_VERSION` below.
 * 2. Re-verify each `MEMPALACE_MAX_*` constant against the cited
 *    upstream source path. Update any that drifted.
 * 3. If the upstream MCP API surface (function names, parameter names)
 *    changed, update the dispatch table in
 *    `src/mempalace/python/mempalace_bridge.py` and its header comment.
 * 4. Run `bun ci`. All consumers — including tests — read from these
 *    constants, so a mismatch surfaces as a test failure rather than
 *    silent runtime drift.
 */

/**
 * Exact PyPI version installed by the managed setup pipeline. Flows into
 * `DEFAULT_CONFIG.mempalace.packageVersion` and, from there, into the
 * `mempalace==<version>` argument handed to `uv pip install`.
 */
export const MEMPALACE_PACKAGE_VERSION = "3.3.5";

/**
 * Upper bound applied internally by `tool_search` and `tool_list_drawers`
 * to the `limit` argument. Any value above this is silently clamped.
 *
 * Source: `mempalace/mcp_server.py` `_MAX_RESULTS = 100`.
 */
export const MEMPALACE_MAX_RESULTS = 100;

/**
 * Maximum search-query length. `tool_search` runs `sanitize_query`, which
 * truncates anything over this threshold (worst case: keeps only the
 * trailing N characters). Above this, prompt-contamination patterns
 * start dominating the embedding signal — see upstream Issue #333.
 *
 * Source: `mempalace/query_sanitizer.py` `MAX_QUERY_LENGTH = 250`.
 */
export const MEMPALACE_MAX_QUERY_LENGTH = 250;

/**
 * Maximum length for wing / room / predicate / entity-style identifiers.
 * `sanitize_name` and `sanitize_kg_value` raise `ValueError` above this.
 *
 * Source: `mempalace/config.py` `MAX_NAME_LENGTH = 128`.
 */
export const MEMPALACE_MAX_NAME_LENGTH = 128;

/**
 * Maximum drawer / diary content length. `sanitize_content` defaults
 * to this when no explicit override is passed.
 *
 * Source: `mempalace/config.py` `sanitize_content(..., max_length: int = 100_000)`.
 */
export const MEMPALACE_MAX_CONTENT_LENGTH = 100_000;

/**
 * Upper bound applied internally by `tool_traverse_graph` to `max_hops`.
 *
 * Source: `mempalace/mcp_server.py` `tool_traverse_graph` — `max(1, min(max_hops, 10))`.
 */
export const MEMPALACE_MAX_HOPS = 10;
