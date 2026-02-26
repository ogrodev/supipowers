# Changelog

All notable changes to this project will be documented in this file.

This project follows **Semantic Versioning**.

## [0.1.2] - 2026-02-26

### Added
- New `/sp-qa` command for QA matrix-driven browser validation with playwright-cli.
- Repo-local QA evidence pipeline under `.pi/supipowers/qa-runs/<run-id>/` (matrix, command logs, screenshots, findings report).
- Repo-local reusable QA auth profile at `.pi/supipowers/qa/auth/profile.json`.
- Playwright skill bundle at `skills/playwright-cli/SKILL.md`, shipped via package manifest.
- QA modules for input parsing, matrix generation, execution runner, storage, and findings synthesis.
- QA workflow events: `qa_matrix_prepared` and `qa_run_completed`.

### Changed
- `/sp-start` auto-advances planning flow and can execute immediately after confirmation.
- Execution flow reused through shared run-execution helper and auto-plan preparation.
- Documentation expanded with QA command usage and storage/security behavior.

## [0.1.1] - 2026-02-26

### Added
- Guided brainstorming kickoff on `/sp-start` with objective requirement and interactive objective prompt fallback.
- Objective reuse on `/sp-start` prompt (press Enter to reuse previous objective).
- New view control command: `/sp-view [compact|full|toggle|status]`.
- Runtime view mode persistence per repository at `.pi/supipowers/view-mode.json`.
- New release automation commands: `/sp-release-setup` and `/sp-release` with pipeline config support.

### Changed
- UI defaults to compact one-line visualization with phase/objective/blocker lock (`🔒`/`🔓`).
- Full mode includes icon-tagged lines for faster scanning.
- View toggle shortcuts simplified to `F6` and `Alt+V`.
- Compact rendering uses below-editor fallback for terminals where footer status slots are not visible.

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
