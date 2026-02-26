# Changelog

All notable changes to this project will be documented in this file.

This project follows **Semantic Versioning**.

## [0.1.0] - 2026-02-26

### Added
- Supipowers extension foundation with workflow state machine.
- Command suite: `/sp-start`, `/sp-status`, `/sp-approve`, `/sp-plan`, `/sp-execute`, `/sp-stop`, `/sp-finish`, `/sp-reset`.
- Routing adapters with fallback: `ant_colony` -> `subagent` -> `native`.
- Quality gates and revalidation tool (`sp_revalidate`).
- Finish workflow with final report generation.
- Recovery path for stale interrupted execution state.
- Event and run history logging.

### Documentation
- Research, architecture, and execution plans in `docs/`.
- Quickstart, configuration, and troubleshooting guides.
