# Orchestrator Agent

> Skill module source is maintained in `.github/skills/orchestrator-agent.js`.

## Purpose
This agent documents the orchestration logic implemented by `orchestrator-agent.js`. It coordinates the end-to-end automation: reading testcases, generating Playwright scripts, executing cases, validating screenshots against Figma, and producing execution reports and updated input workbooks. The agent uses exported functions from the source modules rather than treating the `.js` file as input.

## Location
File: .github/agents/orchestrator-agent.md

## Summary of operations
- Read test-case data from CSV or Excel via the Input Agent.
- For single TOM or all TOMs: coordinate Playwright generation, execution, figma validation, artifact collection, and report generation via child agents.
- Produce per-run artifacts: updated input workbook, `report/Execution_Report.*`, `output/agents/*` JSON artifacts, and per-case artifact folders.

## Trigger Phrases
- "Run TOM_<n>" (e.g., "Run TOM_01")
- "Execute Journey <name>" (e.g., "Execute Journey Mobile PLP")
- "Run Siebel ST Suite" / "Execute all test cases"

## High-level orchestration flow (Agent-driven)
1. Copilot Chat receives a trigger phrase from the user.
2. Orchestrator determines the `input` file (default `input/*.csv` or explicit argument in trigger) and instructs the Input Agent to parse it — Input Agent writes `output/agents/input-output-<ts>.json`.
3. Orchestrator selects testcases (single TOM or filtered journey) based on the parsed artifact and writes a run-plan artifact `output/agents/run-plan-<ts>.json` listing `TOM_ID`s and execution order.
4. For each TOM in the run plan:
   - Orchestrator requests Playwright Generator Agent to produce `output/agents/playwright-<TOM>.json` (action blocks).
   - Orchestrator instructs Execution Agent to run the TOM by providing the testcase and the `playwright-<TOM>.json` artifact; Execution Agent writes `output/agents/execution-result-<TOM>.json` and artifacts under `output/artifacts/<TOM>/`.
   - If a screenshot exists, Orchestrator asks Figma Validator Agent to compare and produce `output/agents/figma-result-<TOM>.json`.
   - Orchestrator asks Artifact Agent to finalize artifact summaries `output/agents/artifact-summary-<TOM>.json`.
5. After all TOMs complete (or on first failure if policy requires early stop) Orchestrator consolidates results into `output/agents/all-results-<ts>.json` and instructs Report Generator Agent to produce final reports and a manifest `output/agents/report-manifest-<ts>.json`.
6. Orchestrator writes a human-readable Markdown summary in `summary-artifacts/orchestrator-summary-<ts>.md` containing totals, pass/fail and a brief table of TOM results.

## Inputs (agent contract)
- `input` file path (CSV/XLSX) — repository `input/` folder.
- Optional: `TOM_ID` or `User_Journey` filter supplied in the trigger phrase.

## Outputs (agent contract)
- `output/agents/input-output-<ts>.json`
- `output/agents/run-plan-<ts>.json`
- `output/agents/playwright-<TOM>.json`
- `output/agents/execution-result-<TOM>.json`
- `output/agents/figma-result-<TOM>.json` (if applicable)
- `output/agents/artifact-summary-<TOM>.json`
- `output/agents/all-results-<ts>.json`
- `output/agents/report-manifest-<ts>.json`
- `summary-artifacts/orchestrator-summary-<ts>.md`

## Child Agents invoked by Orchestrator
- `Input Agent` — parse CSV/XLSX and return structured testcases
- `Playwright Generator Agent` — infer action blocks and helpers
- `Execution Agent` — execute steps in a browser environment and collect artifacts
- `Figma Validator Agent` — compare screenshots with expected images
- `Artifact Agent` — create and finalize artifact folders and summaries
- `Report Generator Agent` — create CSV/Excel/JSON reports and a manifest

## Agent-to-Agent Communication (contract)
- Communication is implemented via workspace artifact files under `output/agents/`.
- Orchestrator writes instruction artifacts (for example `run-plan` and `playwright-requests`) and child agents respond by writing result artifacts to the same folder. Each artifact filename includes a timestamp and `TOM_ID` for idempotence.

## Expected human-visible outputs
- `summary-artifacts/orchestrator-summary-<ts>.md` — Markdown summary with totals and links to `report/` and per-case artifact folders.
- `report/Execution_Report.xlsx` and `report/Execution_Report.csv` — final execution reports.

## Troubleshooting & notes
 - These `.md` files define the agent contracts and the artifact locations; they intentionally avoid telling users to run runtime commands locally. Execution is triggered by the Copilot Chat trigger phrases and carried out by the Orchestrator which coordinates child agents using the artifact contract described above.

---
If you want, I can now:
- Add a small doc-sync helper that ensures each `.github/agents/*.md` contains `Trigger Phrase` and `Execution Steps` (so chat agents will surface them reliably), or
- Create a GitHub Action workflow that performs the orchestrator run remotely (triggerable from PR/Actions UI) and writes the Markdown summary back into `summary-artifacts/`.

Which would you like next?

## Environment variables (commonly used)
- `BASE_URL` — application base URL
- `SIEBEL_USERNAME` / `SIEBEL_PASSWORD` — credentials used by generated login steps
- `INPUT_CSV` — optional default input file path
- `STEP_TIMEOUT_MS`, `HEADLESS`, `PWSLOWMO` — execution options consumed by underlying agents

## Required skills
- Node.js scripting and module composition (loading/exporting functions programmatically)
- Excel and CSV handling (`exceljs`) and workbook manipulation
- Orchestration patterns: sequencing, error isolation, time measurement
- Playwright automation concepts as used by the execution agent
- Image validation basics (Figma validator) and how to incorporate similarity thresholds
- Artifact handling and report generation
- GitHub Copilot (assistant) — included as a skill: the assistant can help refine step-splitting heuristics, add parallel execution, or integrate CI workflows

## How this agent "utilizes" the repository modules
- Invokes `input-agent`, `execution-agent`, `figma-validator`, and `report-generator` as autonomous CLI processes using child process orchestration.
- Parses each agent's JSON output and aggregates final run status.
- Updates input workbooks using `exceljs` and local helper functions.

## Additional artifacts
- `agentTimings` is included in orchestrator JSON output for per-agent runtime tracking.
- A separate summary utility can generate Markdown artifacts (`agent-summary.md`, `agent-sop.md`, `agent-architecture.md`, `agent-timings.md`).

## Troubleshooting & notes
- If the orchestrator cannot find a TOM in the input, ensure `TOM_NUM` values match and `inputFilePath` is correct.
- Figma validation is optional — missing expected images will skip comparison.
- Long-running suites may benefit from running testcases in parallel; the orchestrator currently runs sequentially to simplify artifact collection.
 - Permissions: ensure the agent runtime can write to `report/`, `screenshots/` and `test-results/`.

## Maintenance
- To add parallel execution: make `runFullAutomation()` dispatch to worker pool and update artifact naming to avoid collisions.
- To change result columns or report formats: update `updateInputWorkbook()` and report-generator integration.
- To change Figma comparison policy: add CLI `--threshold` or `options.threshold` and pass it to `validateFigmaScreenshot()` when upgrading the validator.

---
If you want, I can:
- Add a GitHub Action to run `orchestrator-agent.js` on push and upload `report/` and `test-results/` as artifacts, or
- Add a `--parallel` flag to `runFullAutomation()` and implement worker-based execution.

Which would you like next?