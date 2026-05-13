# MemPalace Upstream Audit — 3.3.4 → 3.3.5

- Audit date: 2026-05-12
- supipowers version: 2.0.2
- Current pinned mempalace version: 3.3.4
- Latest audited mempalace version: 3.3.5
- Audit scope: upstream changelog 3.3.4 → 3.3.5 plus direct source verification against the 3.3.5 wheel

## Executive summary

For the default supipowers MemPalace integration (`src/config/defaults.ts:75` sets `defaultAgentName: "omp"`), mempalace 3.3.5 is mostly source-compatible: every `MCP_TOOL_DISPATCH` and `CLI_DISPATCH` target still exists, every pinned `MEMPALACE_MAX_*` constant is unchanged, and most upstream fixes land as passive reliability improvements. The one local blocker for a clean version-only bump is the knowledge-graph temporal contract: upstream now validates `as_of` / `valid_from` / `valid_to` / `ended` as ISO temporal strings (`mempalace/config.py:123-157`, `mempalace/mcp_server.py:1249-1255`, `1283-1290`, `1331-1337`), while our tool schema still advertises `ended` as boolean (`src/mempalace/schema.ts:67`, `129`, `191`). Bump after aligning that schema. Separately, deployments that historically wrote mixed-case diary agent names should run `mempalace repair` before rollout; the default lowercase `omp` path and our current diary formatter are unaffected.

Verified non-impacts:
- No upstream rename/drop of any bridge-dispatched `tool_*` function or CLI subcommand we call; all dispatch targets still resolve in 3.3.5.
- No `MEMPALACE_MAX_*` drift: `MAX_RESULTS=100`, `MAX_QUERY_LENGTH=250`, `MAX_NAME_LENGTH=128`, `MAX_CONTENT_LENGTH=100_000`, `MAX_HOPS=10` still match upstream (`mempalace/mcp_server.py:490`, `863`; `mempalace/query_sanitizer.py:27`; `mempalace/config.py:20`, `171-179`).
- Chroma SQLite lock-release fixes are passive in our short-lived bridge model (`src/mempalace/python/mempalace_bridge.py:1-42`; upstream `mempalace/backends/chroma.py:819-830`, `1340-1359`).
- The room-routing fix in `miner.detect_room()` changes upstream classification behavior but does not break any local contract; supipowers does not hardcode room-routing assumptions (`src/mempalace/python/mempalace_bridge.py:300-312`; upstream `mempalace/miner.py:343-397`).
- Windows stdio UTF-8 hardening is additive; our bridge already forces `PYTHONIOENCODING=utf-8` before spawning CLI subprocesses (`src/mempalace/python/mempalace_bridge.py:44-46`).
- Documentation-only and internal-test changelog entries do not ship in the wheel and have no production effect (`mempalace-3.3.5.dist-info/METADATA:226-228`; wheel contents exclude `tests/`).

## Changelog classification matrix

| Upstream changelog entry | Classification | Evidence | Note |
| --- | --- | --- | --- |
| `tool_search` retry on transient `Error finding id` | Opportunity | `mempalace/mcp_server.py:768-785` | New `index_recovered` signal is preserved by our bridge but hidden by `src/mempalace/format.ts:62-79`. |
| `Diary agent-name lowercasing` | No-impact | `mempalace/mcp_server.py:1391`, `1472`; local default `src/config/defaults.ts:75` | Default `omp` is already lowercase. Mixed-case historical agent names need repair before rollout. `src/mempalace/format.ts:118-130` is unaffected because `tool_diary_read` still omits agent per entry. |
| Reject inverted KG intervals (`valid_to < valid_from`) | No-impact | `mempalace/knowledge_graph.py:264-278`; local bridge `src/mempalace/python/mempalace_bridge.py:227` | We do not forward `valid_to` today, so this guard cannot fire through our bridge. |
| Chroma `close_palace()` / `close()` release SQLite lock | No-impact | `mempalace/backends/chroma.py:819-830`, `1340-1359` | Helpful for long-lived MCP server mode; our per-call subprocess exits already release locks. |
| `EntityRegistry.save()` atomic write | No-impact | `mempalace/entity_registry.py:318-352` | Pure reliability win in upstream CLI flows we already invoke; no local surface change required. |
| `miner.detect_room` token-bounded matching | No-impact | `mempalace/miner.py:343-397` | Upstream routing gets more accurate; no local API/contract change. |
| `mempalace compress` pagination for large palaces | No-impact | `mempalace/closet_llm.py:236-258` / `cli.py` compress path | `compress` is not exposed by `src/mempalace/schema.ts:9-46`. |
| Windows stdio UTF-8 reconfiguration | No-impact | `mempalace/_stdio.py:1-72`, `cli.py:1115-1133`, `fact_checker.py:310-329` | Additive hardening; bridge already sets UTF-8 env. |
| KG temporal input validation (`sanitize_iso_temporal`) | Breaking | `mempalace/config.py:123-157`, `mcp_server.py:1249-1255`, `1283-1290`, `1331-1337` | Our schema still advertises `ended` as boolean and rejects valid explicit date strings. |
| Per-path KG cache instead of module singleton | No-impact | `mempalace/mcp_server.py:111-132`, `1650-1658` | Transparent in our one-shot subprocess model. |
| `mempalace repair --mode from-sqlite` | Opportunity | `mempalace/cli.py:776-825`, `1423-1450`; local bridge `src/mempalace/python/mempalace_bridge.py:325-336` | `mode=from-sqlite` already passes through; `--source` / `--archive-existing` are not yet exposed locally. |
| `CONTRIBUTING.md` git identity guidance | No-impact | `mempalace-3.3.5.dist-info/METADATA:226-228` | Documentation-only. |
| Internal: multiprocessing `spawn` in tests | No-impact | Changelog only; tests not shipped in wheel | Test-only. |
| Internal: SQLite test cleanup | No-impact | Changelog only; tests not shipped in wheel | Test-only. |

## Dispatch verification

### MCP_TOOL_DISPATCH

All local MCP-equivalent dispatch entries still resolve in mempalace 3.3.5.

| Local action | Local dispatch | Upstream 3.3.5 target | Status | Notes |
| --- | --- | --- | --- | --- |
| `status` | `src/mempalace/python/mempalace_bridge.py:213` | `tool_status()` — `mempalace/mcp_server.py:592-631` | OK | Response shape changed slightly (`palace_path` dropped), but formatter handles absence. |
| `list_wings` | `bridge.py:214` | `tool_list_wings()` — `mcp_server.py:667-683` | OK | No kwargs. |
| `list_rooms` | `bridge.py:215` | `tool_list_rooms(wing=None)` — `mcp_server.py:686-707` | OK | `_select("wing")` still matches. |
| `get_taxonomy` | `bridge.py:216` | `tool_get_taxonomy()` — `mcp_server.py:710-729` | OK | No kwargs. |
| `search` | `bridge.py:217` | `tool_search(query, limit=5, wing=None, room=None, max_distance=1.5, min_similarity=None, context=None)` — `mcp_server.py:732-800` | OK | New retry logic and optional `context`; our subset still valid. |
| `check_duplicate` | `bridge.py:218` | `tool_check_duplicate(content, threshold=0.9)` — `mcp_server.py:803-853` | OK | No signature change. |
| `get_aaak_spec` | `bridge.py:219` | `tool_get_aaak_spec()` — `mcp_server.py:856-858` | OK | No kwargs. |
| `get_drawer` | `bridge.py:220` | `tool_get_drawer(drawer_id)` — `mcp_server.py:1087-1115` | OK | `source_file` is now basename-only in metadata. |
| `list_drawers` | `bridge.py:221` | `tool_list_drawers(wing=None, room=None, limit=20, offset=0)` — `mcp_server.py:1118-1174` | OK | Adds `total`; our formatter ignores it today. |
| `add_drawer` | `bridge.py:222` | `tool_add_drawer(wing, room, content, source_file=None, added_by="mcp")` — `mcp_server.py:954-1019` | OK | No signature change. |
| `update_drawer` | `bridge.py:223` | `tool_update_drawer(drawer_id, content=None, wing=None, room=None)` — `mcp_server.py:1177-1243` | OK | No signature change. |
| `delete_drawer` | `bridge.py:224` | `tool_delete_drawer(drawer_id)` — `mcp_server.py:1022-1050` | OK | No signature change. |
| `kg_query` | `bridge.py:226` | `tool_kg_query(entity, as_of=None, direction="both")` — `mcp_server.py:1249-1261` | OK | `subject → entity` rename still correct. Temporal validation added. |
| `kg_add` | `bridge.py:227` | `tool_kg_add(subject, predicate, object, valid_from=None, valid_to=None, source_closet=None, source_file=None, source_drawer_id=None)` — `mcp_server.py:1264-1318` | OK | New optional kwargs available; local extractor still resolves but leaves value on the table. |
| `kg_invalidate` | `bridge.py:228` | `tool_kg_invalidate(subject, predicate, object, ended=None)` — `mcp_server.py:1321-1356` | OK | Upstream still accepts `ended`, but now requires ISO string instead of tolerating arbitrary values. |
| `kg_timeline` | `bridge.py:229` | `tool_kg_timeline(entity=None)` — `mcp_server.py:1359-1367` | OK | `subject → entity` rename still correct. |
| `kg_stats` | `bridge.py:230` | `tool_kg_stats()` — `mcp_server.py:1370-1372` | OK | No kwargs. |
| `traverse` | `bridge.py:232` | `tool_traverse_graph(start_room, max_hops=2)` — `mcp_server.py:861-867` | OK | No signature change. |
| `find_tunnels` | `bridge.py:235` | `tool_find_tunnels(wing_a=None, wing_b=None)` — `mcp_server.py:870-880` | OK | `source_wing → wing_a`, `target_wing → wing_b` rename still correct. Local `source_room` requirement in `schema.ts:144` is a pre-existing over-validation bug, not an upstream regression. |
| `graph_stats` | `bridge.py:236` | `tool_graph_stats()` — `mcp_server.py:883-888` | OK | No kwargs. |
| `create_tunnel` | `bridge.py:237` | `tool_create_tunnel(source_wing, source_room, target_wing, target_room, label="", source_drawer_id=None, target_drawer_id=None)` — `mcp_server.py:891-921` | OK | New optional provenance kwargs remain unexposed locally. |
| `list_tunnels` | `bridge.py:238` | `tool_list_tunnels(wing=None)` — `mcp_server.py:924-930` | OK | No signature change. |
| `delete_tunnel` | `bridge.py:239` | `tool_delete_tunnel(tunnel_id)` — `mcp_server.py:933-937` | OK | No signature change. |
| `follow_tunnels` | `bridge.py:241` | `tool_follow_tunnels(wing, room)` — `mcp_server.py:940-948` | OK | `source_wing/source_room → wing/room` rename still correct. |
| `diary_write` | `bridge.py:242` | `tool_diary_write(agent_name, entry, topic="general", wing="")` — `mcp_server.py:1378-1452` | OK | Semantic change: `agent_name` lowercased. |
| `diary_read` | `bridge.py:243` | `tool_diary_read(agent_name, last_n=10, wing="")` — `mcp_server.py:1455-1522` | OK | Bridge does not expose `last_n`; existing default of 10 unchanged. Semantic change: `agent_name` lowercased. |
| `hook_settings` | `bridge.py:244` | `tool_hook_settings(silent_save=None, desktop_toast=None)` — `mcp_server.py:1525-1566` | OK | Bridge intentionally calls getter form with no kwargs. |
| `memories_filed_away` | `bridge.py:245` | `tool_memories_filed_away()` — `mcp_server.py:1569-1597` | OK | No signature change. |
| `reconnect` | `bridge.py:246` | `tool_reconnect()` — `mcp_server.py:1603-1688` | OK | More thorough reset, same callable target. |

### CLI_DISPATCH

| Local action | Local dispatch | Upstream 3.3.5 parser | Status | Notes |
| --- | --- | --- | --- | --- |
| `init` | `src/mempalace/python/mempalace_bridge.py:293-297` | `cli.py:1155-1179` | OK | `dir` positional and `--yes` still valid. |
| `mine` | `bridge.py:300-312` | `cli.py:1237-1282` | OK | `dir`, `--mode`, `--limit`, `--include-ignored`, `--no-gitignore`, `--extract` still valid. |
| `split` | `bridge.py:315-322` | `cli.py:1350-1371` | OK | `dir` positional and `--mode` are still accepted by local CLI wrapper; upstream parser still accepts `dir` and other options. |
| `repair` | `bridge.py:325-336` | `cli.py:1403-1475`, `776-825` | OK (partial) | `--mode from-sqlite` already passes through because `mode` is a free string, but new `--source` and `--archive-existing` flags are not exposed by the local schema or CLI builder. |

## Breaking changes

### 1. KG temporal validation now conflicts with the local `ended` tool contract

**Upstream evidence**
- `mempalace/config.py:123-157` adds `sanitize_iso_temporal()`, accepting only `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SSZ`, and `YYYY-MM-DDTHH:MM:SS+00:00`.
- `mempalace/mcp_server.py:1249-1255` now validates `kg_query.as_of`.
- `mempalace/mcp_server.py:1283-1290` now validates `kg_add.valid_from` / `valid_to`.
- `mempalace/mcp_server.py:1331-1337` now validates `kg_invalidate.ended`.

**Local impact**
- `src/mempalace/schema.ts:67` declares `ended?: boolean` in `MempalaceParams`.
- `src/mempalace/schema.ts:129` includes `ended` in `BOOLEAN_FIELDS`.
- `src/mempalace/schema.ts:191` exposes `ended` as `{ type: "boolean" }` in the public tool schema.
- `src/mempalace/python/mempalace_bridge.py:228` forwards `ended` verbatim to `tool_kg_invalidate()`.

**What breaks**
- A caller that follows our current tool schema and sends `ended: true` now gets a runtime validation error from upstream instead of the 3.3.4 behavior.
- A caller cannot send a valid explicit end date through our local tool surface at all, because the schema rejects the correct upstream type.
- This is a real local contract mismatch, not just an upstream bug fix: our published tool schema is now wrong for 3.3.5.

**Recommendation**
- Change `ended` to `string` in `src/mempalace/schema.ts`.
- Remove `ended` from `BOOLEAN_FIELDS`.
- Add explicit ISO-temporal validation or at least a format hint for `as_of`, `valid_from`, `valid_to`, and `ended`.
- Update `tests/mempalace/schema.test.ts` to assert the corrected contract before bumping the pin.

## Opportunities

### 1. Expose `index_recovered` in formatted search output
- Priority: Medium
- Effort: Small
- Evidence: upstream `mempalace/mcp_server.py:768-785`; local `src/mempalace/format.ts:62-79`, `src/mempalace/tool.ts:181-188`, `src/mempalace/bridge.ts:124-132`
- Why: 3.3.5 adds a useful observable signal when `tool_search` self-heals after the Chroma HNSW flush window. Our bridge preserves the field, but the model never sees it because the formatter drops it.
- Implementation sketch:
  1. In `formatSearch()`, append a one-line note when `record.index_recovered` is truthy.
  2. Add a formatter test in `tests/mempalace/format.test.ts`.

### 2. Guard hook timeout budgets against the new 2s retry sleep
- Priority: Low
- Effort: Small
- Evidence: upstream `mempalace/mcp_server.py:773`; local `src/config/defaults.ts:95`, `src/mempalace/hooks.ts:282-288`, `src/mempalace/bridge.ts:57-63`
- Why: the new `tool_search` retry path always sleeps 2 seconds before retrying. Default budgets still clear comfortably (`hookMs=10000`, `bridgeMs=30000`), but tightened hook budgets can now turn a transient-recovery search into a timeout instead of a self-healed result.
- Implementation sketch:
  1. Document `hookMs >= 6000` as the practical floor when auto-search is enabled.
  2. If tighter budgets are required, skip auto-search on low-timeout configs or surface a warning in config docs.

### 3. Wire `valid_to` into `kg_add`
- Priority: Medium
- Effort: Small
- Evidence: upstream `mempalace/mcp_server.py:1264-1273`; local `src/mempalace/python/mempalace_bridge.py:227`; local schema already has `valid_to` at `src/mempalace/schema.ts:66`, `190`
- Why: 3.3.5 can now record bounded historical facts in one call. Our bridge still exposes only `valid_from`.
- Implementation sketch:
  1. Extend the `kg_add` extractor to include `valid_to`.
  2. Add a bridge test that records the forwarded kwargs.

### 4. Expose full `repair --mode from-sqlite` recovery flags
- Priority: High
- Effort: Medium
- Evidence: upstream `mempalace/cli.py:776-825`, `1435-1450`; local `src/mempalace/python/mempalace_bridge.py:325-336`; local `src/mempalace/schema.ts:81-88`
- Why: `mode="from-sqlite"` already passes through, but the two flags that make the new recovery path operational (`--source`, `--archive-existing`) are unreachable from our tool surface.
- Implementation sketch:
  1. Add `source` / `archive_existing` fields to `MempalaceParams` and the JSON schema.
  2. Append them in `_make_cli_args_repair()`.
  3. Add bridge/runtime tests covering in-place and alternate-source recovery argv construction.

### 5. Surface `list_drawers.total` for pagination-aware callers
- Priority: Low
- Effort: Small
- Evidence: upstream `mempalace/mcp_server.py:1147-1172`; local `src/mempalace/format.ts:81-93`
- Why: 3.3.5 now returns the total matching row count, which lets callers know whether more pages exist.
- Implementation sketch:
  1. Include `total` in the formatted drawer list header or details surface.
  2. Add a formatter regression test.

## Constants drift table

| Constant | Local value | Upstream 3.3.5 value | Drift | Upstream proof |
| --- | --- | --- | --- | --- |
| `MEMPALACE_MAX_RESULTS` | `100` | `100` | None | `mempalace/mcp_server.py:490` |
| `MEMPALACE_MAX_QUERY_LENGTH` | `250` | `250` | None | `mempalace/query_sanitizer.py:27` |
| `MEMPALACE_MAX_NAME_LENGTH` | `128` | `128` | None | `mempalace/config.py:20` |
| `MEMPALACE_MAX_CONTENT_LENGTH` | `100_000` | `100_000` | None | `mempalace/config.py:171-179` |
| `MEMPALACE_MAX_HOPS` | `10` | `10` | None | `mempalace/mcp_server.py:861-863` |

Version-pin delta:
- `MEMPALACE_PACKAGE_VERSION` is the only value that must change for the upgrade: local `src/mempalace/upstream-limits.ts:28` is `"3.3.4"`; upstream wheel metadata is `3.3.5` (`mempalace-3.3.5.dist-info/METADATA:3`).

## Bump plan

1. Fix the KG temporal contract in `src/mempalace/schema.ts`:
   - change `ended` from boolean to string,
   - remove it from `BOOLEAN_FIELDS`,
   - document or validate ISO temporal formats for `as_of`, `valid_from`, `valid_to`, and `ended`.
2. Update the mempalace schema tests to lock the corrected temporal contract.
3. If any deployment has historical diary data written under mixed-case agent names, run `mempalace repair` before rollout; default lowercase `omp` does not need migration.
4. [Recommended] Extend `kg_add` dispatch to forward `valid_to`.
5. [Recommended] Expose `repair --mode from-sqlite`’s `--source` and `--archive-existing` flags if the tool surface should support full palace recovery.
6. Bump `src/mempalace/upstream-limits.ts` `MEMPALACE_PACKAGE_VERSION` from `3.3.4` to `3.3.5`. No `MEMPALACE_MAX_*` edits are required.
7. Run the focused mempalace integration suite:
   - `bun test tests/mempalace/schema.test.ts tests/mempalace/bridge.test.ts tests/mempalace/runtime.test.ts tests/mempalace/tool.test.ts tests/mempalace/installer-helper.test.ts tests/mempalace/config.test.ts tests/commands/memory.test.ts tests/commands/update.test.ts`
8. Run `bun ci`.
