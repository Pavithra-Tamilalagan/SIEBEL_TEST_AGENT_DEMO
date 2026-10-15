# Summary Artifact (Markdown-Only)

## Location policy
- This summary definition is intentionally kept outside `.github/agents` and `.github/skills`.
- Folder: `summary-artifacts/`

## Purpose
Create and maintain summary artifacts as Markdown files only.

## Required markdown outputs
- `agent-summary.md`
- `agent-sop.md`
- `agent-architecture.md`
- `agent-timings.md`

## Input expectations
- Orchestrator result JSON should contain:
  - `total`, `passed`, `failed`, `executionTime`
  - `report`
  - `agentTimings` (array)

## SOP content (minimum)
1. Load environment.
2. Read testcase input.
3. Execute testcases.
4. Capture artifacts.
5. Run optional visual validation.
6. Generate reports.
7. Publish final summary.

## Architecture section
Include Mermaid flowchart in markdown showing:
- orchestrator
- input agent
- execution agent
- artifact agent
- figma validator
- report generator

## Generic rule
- Do not create summary generator as `.js`.
- Keep summary artifacts as `.md` only.
- Keep summary files in `summary-artifacts/` folder.
