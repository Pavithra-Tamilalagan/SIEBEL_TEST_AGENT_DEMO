# Skills Modules

This folder contains JS skill modules used by autonomous agents. Keep these modules independent and reusable.

## Skill modules
- `input-agent.js` — input parsing/validation (CSV/XLS/XLSX)
- `playwright-generator.js` — action/script generation
- `execution-agent.js` — browser step execution
- `artifact-agent.js` — screenshots/trace/video artifact management
- `figma-validator.js` — expected vs actual screenshot validation
- `report-generator.js` — CSV/Excel/JSON report generation
- `orchestrator-agent.js` — coordinator flow

## Contract
- No hardcoded input defaults in runtime CLI paths/IDs.
- Accept required inputs via CLI args or environment variables.
- Return machine-readable JSON to stdout for orchestration.
- Use non-zero exit codes on validation/runtime errors.

## Summary artifacts policy
- Summary artifacts are Markdown-only files.
- Keep summary files outside `agents` and `skills` under `summary-artifacts/`.
