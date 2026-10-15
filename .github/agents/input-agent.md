# Input Agent — `input-agent.js`

> Skill module source is maintained in `.github/skills/input-agent.js`.
```chatagent
# Input Agent

Purpose
- Read and validate the test-case spreadsheet (CSV or Excel) and expose structured test-case objects to the Orchestrator and child agents.

Inputs
- `input/<filename>.csv` or `input/<filename>.xlsx` — the repository input file containing the test cases.
- Required columns (case-sensitive): `TOM_NUM`, `User_Journey`, `Order_Steps`, `Post_Verification`.

Trigger Phrase
- "List test cases"
- "Show Journey <name>" (e.g., "Show Journey Mobile PLP")

Execution Steps (Agent-driven)
1. Copilot Chat receives a trigger (for example: "Execute Journey Mobile PLP").
2. Orchestrator Agent instructs the Input Agent to read `input/<filename>` and return parsed test-case objects.
3. Input Agent validates required columns, normalizes fields, and returns a JSON array of test-case objects to the Orchestrator (via the agreed workspace artifact: `output/agents/input-output-<timestamp>.json`).

Agent-to-Agent Communication
- The Input Agent writes its parsed output to a workspace artifact file in `output/agents/` (JSON). The Orchestrator reads that file to decide which test cases to execute.

Expected Output
- `output/agents/input-output-<timestamp>.json` containing an array of test-case objects with keys: `TOM_NUM`, `User_Journey`, `Order_Steps`, `Post_Verification`.

Notes
- These `.md` instructions are the canonical trigger and integration contract. They document the inputs, triggers, and artifact locations that other agents rely on.
```
    - `csvFilePath` optional; if provided the file must be located inside the repository `input/` folder (the agent enforces this). If omitted, the agent falls back to `process.env.INPUT_CSV`.

