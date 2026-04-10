---
name: supi:mcpc
description: Use mcpc CLI to interact with MCP servers managed by supipowers. Triggers on: $figma, $local-db or any mcpc tool invocation.
allowed-tools: Bash(mcpc:*)
---

# mcpc: MCP tools via supipowers

Use the `mcpc_<name>` gateway tools to interact with MCP servers.
Each server has a dedicated tool registered in your Available Tools.

## Quick Reference

The gateway tools accept `tool` (MCP tool name) and `args` (key-value object).
Under the hood, they run: `mcpc --json @supi-<name> tools-call <tool> key:=value`

## Available Servers

### figma (@supi-figma)
Tools: 

### local-db (@supi-local-db)
Tools: 
