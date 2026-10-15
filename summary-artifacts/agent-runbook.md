# Siebel Test Agent Runbook

## Purpose
This runbook explains the actual end-to-end workflow used in this repository for Siebel journey automation.

It covers:
- what each agent/skill is responsible for
- how input moves through the system
- where generated files and runtime artifacts are created
- how to run, verify, and maintain the workflow

## Current workflow at a glance
1. Prepare environment variables.
2. Provide testcase input files.
3. Parse testcase rows into structured journey data.
4. Convert structured steps into Playwright action blocks.
5. Execute the journey in the browser.
6. Capture screenshots, traces, and video on demand.
7. Generate execution summaries and reports.
8. Review failures, refine reusable skills, and re-run.

## Main folders and their role
- [.github/agents/](.github/agents/) — Markdown agent contracts and responsibilities.
- [.github/skills/](.github/skills/) — reusable JavaScript implementation for parsing, generation, execution, artifacts, and reporting.
- [input/](input/) — source business input such as CSV and Excel files.
- [tests/](tests/) — manual/reference Playwright specs, including [tests/TOM_01.spec.js](tests/TOM_01.spec.js).
- [scripts/](scripts/) — helper scripts used for synchronization and validation.
- [tools/](tools/) — utility scripts for inspection and timing analysis.
- [output/](output/) — generated runtime output, reports, parsed files, and generated specs. This is treated as transient.
- [summary-artifacts/](summary-artifacts/) — human-readable runbook and architecture documentation.

## Actual end-to-end flow

### 1. Environment preparation
The workflow expects runtime configuration from environment files.

Typical examples:
- `BASE_URL`
- `SIEBEL_USERNAME`
- `SIEBEL_PASSWORD`
- customer and journey-specific values like names, contact details, address, and customer setup fields

Local secret files such as `.env` and `.env.local` stay outside Git.

### 2. Input ingestion
Business testcases come from files in [input/](input/), for example CSV or Excel.

The input skill reads rows such as:
- `TOM_ID`
- `User_Journey`
- `Order_Steps`
- `Post_Verification`

Responsibility:
- normalize line endings and whitespace
- preserve journey intent
- produce structured testcase data for downstream steps

Related files:
- [.github/agents/input-agent.md](.github/agents/input-agent.md)
- [.github/skills/input-agent.js](.github/skills/input-agent.js)

### 3. Journey normalization
After parsing, the workflow extracts reusable runtime options from testcase content.

Examples:
- customer first and last name
- address lookup query
- suggested address hints
- post-verification assertions

This allows future journeys to stay input-driven instead of hardcoding most values inside Playwright scripts.

Related file:
- [.github/skills/playwright-generator.js](.github/skills/playwright-generator.js)

### 4. Playwright generation
The generator converts natural-language steps into robust Playwright actions.

What it does:
- maps phrases like login, click, enter, verify into code blocks
- builds locators using roles, text, labels, and fallbacks
- emits helper logic for repeated journey operations
- adds verification blocks from `Post_Verification`

For Mobile PLP-type flows, the generator includes shared helper behavior such as:
- login handling
- Sales Calculator navigation
- address lookup flow
- coverage page checks
- Mobile PLP arrival checks
- Create Quote and Create Order safeguards

Related files:
- [.github/agents/playwright-generator-agent.md](.github/agents/playwright-generator-agent.md)
- [.github/skills/playwright-generator.js](.github/skills/playwright-generator.js)

### 5. Browser execution
The execution layer runs the generated or reference Playwright logic against Siebel.

What it is responsible for:
- opening the browser
- replaying the normalized steps
- waiting for required state changes
- stopping on real blocking conditions
- reporting pass/fail status

Related files:
- [.github/agents/execution-agent.md](.github/agents/execution-agent.md)
- [.github/skills/execution-agent.js](.github/skills/execution-agent.js)

### 6. Artifact capture
During execution, the artifact layer captures runtime evidence.

Possible artifacts:
- success screenshots
- failure screenshots
- Playwright traces
- recorded video

These outputs are generated locally and are intentionally not committed.

Related files:
- [.github/agents/artifact-agent.md](.github/agents/artifact-agent.md)
- [.github/skills/artifact-agent.js](.github/skills/artifact-agent.js)

### 7. Optional visual validation
If a flow requires image-level comparison or UI validation, the Figma validator layer can be used.

Responsibility:
- compare expected and actual screenshots
- surface mismatch data for reporting

Related files:
- [.github/agents/figma-validator-agent.md](.github/agents/figma-validator-agent.md)
- [.github/skills/figma-validator.js](.github/skills/figma-validator.js)

### 8. Reporting and summary generation
The report layer consolidates the outcome.

Typical outputs include:
- JSON execution summaries
- generated testcases
- report files
- timing or dependency summaries

Related files:
- [.github/agents/report-generator-agent.md](.github/agents/report-generator-agent.md)
- [.github/skills/report-generator.js](.github/skills/report-generator.js)

## How TOM_01 fits into this design
[tests/TOM_01.spec.js](tests/TOM_01.spec.js) is a maintained reference implementation for one journey.

It is useful for:
- debugging unstable selectors
- validating business behavior live in headed mode
- confirming fixes before pushing generator refinements back into shared logic

It should not be treated as the only future journey path.

The long-term reusable path is:
- input file
- parser
- generator
- execution skill
- artifacts
- report

## Generic vs journey-specific behavior

### What should remain generic
These should stay in shared skills:
- parsing `Order_Steps`
- deriving journey runtime options
- common click/fill/wait/verify helpers
- popup handling patterns
- artifact generation
- report generation

### What may be journey-specific
These can vary by journey and should be isolated where possible:
- unique screen names
- special button labels
- journey-only verifications
- exceptional business rule popups
- product or plan choice preferences

### Recommended maintenance rule
Do not create a new core generator for every journey.

Preferred approach:
1. keep shared logic in [.github/skills/playwright-generator.js](.github/skills/playwright-generator.js)
2. keep journey data in input files
3. if special mappings are required, isolate them in separate journey-specific config or mapping files
4. use manual specs in [tests/](tests/) only as reference or targeted regression coverage

## Current known behavior from this repository
- [tests/TOM_01.spec.js](tests/TOM_01.spec.js) contains hardened logic for Mobile PLP and Create Order validation.
- [.github/skills/playwright-generator.js](.github/skills/playwright-generator.js) contains shared generation logic, but still includes some Journey1-specific mappings that should gradually move to separate config if more journeys are added.
- Generated folders such as [output/](output/), [screenshots/](screenshots/), and [test-results/](test-results/) are runtime artifacts and should not be committed.

## Manual operating procedure

### To run locally
1. Ensure Node.js dependencies are installed.
2. Ensure `.env.local` or equivalent runtime secrets are present.
3. Place testcase files in [input/](input/).
4. Run the required parser/generator/execution flow or a reference test.
5. Review local artifacts and failures.
6. Refine shared skills when the issue is generic.
7. Refine a journey mapping or reference spec when the issue is journey-specific.

### To verify a fix safely
1. reproduce the failure
2. inspect visible UI state and artifact evidence
3. fix the shared or reference logic
4. re-run in headed mode if user flow confirmation is needed
5. confirm that pass criteria reflect actual business progression
6. remove transient artifacts before commit

### To prepare for commit
1. keep source files only
2. remove or ignore generated artifacts
3. ensure `.env` files are excluded
4. confirm `.gitignore` is correct
5. commit only reusable code and documentation

## Expected future usage
For a new journey:
1. add or parse the new business input
2. let the shared parser and generator attempt the first pass
3. refine shared mappings only when they are reusable
4. isolate special behavior in separate journey-specific mapping/config files if needed
5. avoid cloning the entire generator for each journey

## End-state expectation
The ideal workflow is:
- one reusable parser
- one reusable generator core
- one reusable execution layer
- one reusable artifact layer
- one reusable reporting layer
- optional small journey-specific mapping/config files only when truly required