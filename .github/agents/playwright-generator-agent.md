# Playwright Generator Agent

> Skill module source is maintained in `.github/skills/playwright-generator.js`.

## Purpose
This agent reproduces the behavior of `playwright-generator.js` to generate Playwright test scripts from a JSON test-case file. It provides a concise description of the algorithm, invocation examples, required skills (including the assistant), and troubleshooting tips.

## Location
File: .github/agents/playwright-generator-agent.md

## Summary of operations
- Read a JSON test-case file containing `steps` or `Order_Steps` and optional `Post_Verification`.
- Normalize and parse natural-language step text.
- Infer actions (login, navigate Site Map, launch Sales Calculator, fill fields, click buttons, verify text).
- Emit Playwright code blocks for each inferred action.
- Provide a generic `launchMobilePLP(page, journeyOptions)` helper when Mobile PLP flow is detected.
- Generate conservative verification/assertion code for known phrases and for content listed in `Post_Verification`.
- Avoid duplicate navigation steps when helper covers them.

## Agent algorithm (behavior overview)
1. Load and parse the input JSON file.
2. Extract `steps` (or `Order_Steps`).
3. For each step string:
   - Normalize whitespace and remove extra punctuation.
   - Extract quoted text where present.
   - Try to infer the target field or UI element using keyword heuristics (`enter`, `click`, `verify`, etc.).
   - Map common phrases to robust Playwright locators and flows (role-based locators, ids, fallback DOM queries).
  - Derive reusable runtime options from testcase data, such as address-search input, suggestion hints, and example customer names, so journey-specific values stay in the input artifact instead of being hardcoded in the helper.
   - If the step requests login, emit a secure env-driven login block.
   - If the Mobile PLP flow is detected, generate a reusable `launchMobilePLP(page)` helper and use a single invocation.
4. Build the final `.spec.js` script with imports, optional helper, `test()` wrapper, `page.goto(process.env.BASE_URL);` and the generated blocks.
5. Parse `Post_Verification` for auto-assertions (messages, visible tabs, URL changes) and append them.

## Inputs
- A JSON file path (e.g., `input/test-case.json`) containing test-case data. Expected fields:
  - `steps` or `Order_Steps`: array of step strings.
  - Optional `Post_Verification` / `PostVerification`: free text for additional assertions.

## Outputs
- A generated Playwright test file printed to stdout or written by the runner (e.g., `generated.spec.js`).

## Trigger Phrase
- "Generate Playwright for <TOM_ID>" or "Create script for Journey <name>"

Execution Steps (Agent-driven)
1. Orchestrator instructs the Playwright Generator Agent with a parsed testcase artifact path and `TOM_ID`.
2. Playwright Generator reads the testcase, infers action blocks and verification assertions, and writes `output/agents/playwright-<TOM_ID>.json` describing action blocks and helpers.
3. Execution Agent consumes the `playwright-<TOM_ID>.json` artifact to run the steps in a browser context.

Expected Output
- `output/agents/playwright-<TOM_ID>.json` — structured action blocks and optional helper code snippets for the Execution Agent to consume.

Notes
- Environment variables such as `BASE_URL`, `SIEBEL_USERNAME`, `SIEBEL_PASSWORD` are documented by the Orchestrator and supplied at runtime by the execution environment; they are not required to be set by end users when triggering via Copilot Chat (the Orchestrator provides them as part of the execution context).

## Required skills
- Node.js scripting and `fs/promises` (file read/write)
- Text normalization and regex-based parsing
- Playwright test APIs (`test`, `expect`, role-based locators, `page.goto`, `page.waitForFunction`)
- Robust DOM fallbacks and defensive programming for flaky UIs
- Environment-variable-based secrets handling
- GitHub Copilot (assistant): `GitHub Copilot (GPT-5 mini)` — included as an agent/skill to assist with natural-language inference and code generation

## Generated helper behavior (short)
- `launchMobilePLP(page, journeyOptions)`: ensures `BASE_URL`, performs login if necessary, opens the Site Map, searches for `Sales calculator`, fills basic customer info, uses input-derived address-search data, waits for coverage/network details, and navigates to Mobile PLP with conservative waits and fallbacks.

## Auto-assertion rules
- Known phrases (e.g., `Sales calculator`, `Mobile PLP`, `Coverage Check`) map to `page.getByText()` visibility checks guarded with counts and `.isVisible()`.
- `Post_Verification` lines like `Message shown: X` produce `expect(page.getByText(/X/i)).toBeVisible()`.
- Ambiguous verifications are left as `// Manual verification required: ...` comments.

## Troubleshooting & notes
- Ensure Node.js >= 14 (prefer 16+).
- If Playwright tests run later, install Playwright dependencies and browsers: `npx playwright install`.
- If generated locators fail on your instance, update the mapping heuristics in `.github/skills/playwright-generator.js`.
- The generator intentionally uses conservative assertions to avoid false positives.

## Maintenance
- To extend inference, edit `generateActionBlock`, `generateVerifyBlock`, or add new transformers in the JS source at `.github/skills/playwright-generator.js`.
- To add more auto-assertion patterns, update `generateAssertionsFromPostVerification`.

---
If you want, I can also:
- Add a small wrapper script to run the generator and optionally write the output file.
- Create a GitHub Action that runs the generator on PRs.

Would you like me to add any of those? 

## Notes about usage (implementation detail)
- This agent documents and re-uses the module's exported functions (for example `generatePlaywrightScript`, `generateActionBlock`, and `generateLaunchMobilePLPFunction`) when called programmatically; it does **not** treat the `.js` source file as a data input. Consumers should `require('.github/skills/playwright-generator')` and call the exported helpers.
- CLI mode in the JS file remains available for convenience (reading a JSON file and printing a generated script), but intended integrations (orchestrator/execution agents) should call the module's functions directly.
- Generic policy: no hardcoded runtime inputs; testcase data should be supplied explicitly by caller/CLI, and Mobile PLP helper behavior should be driven by `journeyOptions` derived from the testcase.
