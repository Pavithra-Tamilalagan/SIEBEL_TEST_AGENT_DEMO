# Execution Agent

> Skill module source is maintained in `.github/skills/execution-agent.js`.
```chatagent
# Execution Agent

Purpose
- Execute a single TOM (test-case) by following the `Order_Steps` and capturing artifacts and verification results.

Inputs
- `TOM_ID` (e.g., `TOM_01`) identified by the Orchestrator.
- Parsed testcase object produced by the Input Agent (artifact file in `output/agents/`).
- Environment secrets and configuration (documented by the Orchestrator): `BASE_URL`, `SIEBEL_USERNAME`, `SIEBEL_PASSWORD`, optional `HEADLESS`.

Trigger Phrase
- "Run <TOM_ID>" (e.g., "Run TOM_01")

Execution Steps (Agent-driven)
1. Orchestrator instructs Execution Agent to run `TOM_ID` and provides the parsed testcase artifact path.
2. Execution Agent reads the testcase artifact from `output/agents/input-output-<timestamp>.json` and finds the matching `TOM_ID`.
3. The agent normalizes `Order_Steps` into executable actions, derives generic `journeyOptions` from testcase content, and maps verification steps from `Post_Verification`.
4. Execution Agent requests a Playwright script from the Playwright Generator Agent (via `output/agents/playwright-<TOM_ID>.json`) describing action blocks.
5. Execution Agent executes the action blocks in a controlled browser context, reusing shared helpers with testcase-derived `journeyOptions`, and captures screenshots/traces/video into `output/artifacts/<TOM_ID>/`.
6. Execution Agent writes its result object to `output/agents/execution-result-<TOM_ID>.json` including status (`PASS`/`FAIL`), reason, and artifact paths.

Agent-to-Agent Communication
- Input Agent → Orchestrator: `output/agents/input-output-<timestamp>.json` (parsed testcases).
- Orchestrator → Execution Agent: selected `TOM_ID` and artifact path.
- Playwright Generator Agent → Execution Agent: `output/agents/playwright-<TOM_ID>.json` (action blocks).
- Execution Agent → Artifact/Report Agents: result JSON and artifact directories under `output/artifacts/<TOM_ID>/`.

Expected Output
- `output/agents/execution-result-<TOM_ID>.json` with keys: `testCaseId`, `status` (`PASS`/`FAIL`), `screenshot`, `trace`, `video`, `reason`.
- Saved artifacts under `output/artifacts/<TOM_ID>/`.

Notes
- The `.md` describes the contract and artifact locations used by Orchestrator and child agents. It intentionally avoids local CLI commands — execution is driven by triggers and artifacts.
```
- Execute a single TOM (test-case) by following the `Order_Steps` and capturing artifacts and verification results.

Inputs
- `TOM_ID` (e.g., `TOM_01`) identified by the Orchestrator.
- Parsed testcase object produced by the Input Agent (artifact file in `output/agents/`).
- Environment secrets and configuration (documented by the Orchestrator): `BASE_URL`, `SIEBEL_USERNAME`, `SIEBEL_PASSWORD`, optional `HEADLESS`.

Trigger Phrase
- "Run <TOM_ID>" (e.g., "Run TOM_01")

Execution Steps (Agent-driven)
1. Orchestrator instructs Execution Agent to run `TOM_ID` and provides the parsed testcase artifact path.
2. Execution Agent reads the testcase artifact from `output/agents/input-output-<timestamp>.json` and finds the matching `TOM_ID`.
3. The agent normalizes `Order_Steps` into executable actions and maps verification steps from `Post_Verification`.
4. Execution Agent requests a Playwright script from the Playwright Generator Agent (via `output/agents/playwright-<TOM_ID>.json`) describing action blocks.
5. Execution Agent executes the action blocks in a controlled browser context, capturing screenshots/traces/video into `output/artifacts/<TOM_ID>/`.
6. Execution Agent writes its result object to `output/agents/execution-result-<TOM_ID>.json` including status (`PASS`/`FAIL`), reason, and artifact paths.

Agent-to-Agent Communication
- Input Agent → Orchestrator: `output/agents/input-output-<timestamp>.json` (parsed testcases).
- Orchestrator → Execution Agent: selected `TOM_ID` and artifact path.
- Playwright Generator Agent → Execution Agent: `output/agents/playwright-<TOM_ID>.json` (action blocks).
- Execution Agent → Artifact/Report Agents: result JSON and artifact directories under `output/artifacts/<TOM_ID>/`.

Expected Output
- `output/agents/execution-result-<TOM_ID>.json` with keys: `testCaseId`, `status` (`PASS`/`FAIL`), `screenshot`, `trace`, `video`, `reason`.
- Saved artifacts under `output/artifacts/<TOM_ID>/`.

Notes
- The `.md` describes the contract and artifact locations used by Orchestrator and child agents. It intentionally avoids local CLI commands — execution is driven by triggers and artifacts.
```