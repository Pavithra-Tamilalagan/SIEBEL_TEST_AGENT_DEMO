# Figma Validator Agent

> Skill module source is maintained in `.github/skills/figma-validator.js`.

## Purpose
This agent documents and describes the behavior of the `figma-validator.js` module. It validates that a produced Playwright screenshot matches an expected Figma screenshot (currently existence-only, pluggable comparison).

## Location
File: .github/agents/figma-validator-agent.md

## Summary of operations
- Resolve absolute paths for the expected Figma image and an actual Playwright screenshot.
- Ensure both files exist; fail fast with clear errors if missing.
- Run a comparison function (`compareImages`) that currently returns a best-effort similarity and status.
- Normalize the similarity to the 0–100 range and return `{ similarity, status }`.

## Behavior / Algorithm
1. Validate both `expectedImagePath` and `actualImagePath` are provided.
2. Resolve both paths to absolute locations and verify file existence using `fs.access`.
3. Call `compareImages(expected, actual)`.
   - Current implementation performs an existence-based pass-through and returns `{similarity:100, status:'PASS'}`.
   - The function is intentionally pluggable so pixel/structural comparison libraries (e.g., `pixelmatch`, `resemblejs`) can be integrated later.
4. Normalize the reported similarity to an integer 0–100 and return the result.

## Inputs
- `expectedImagePath` — path to the golden/expected Figma export image.
- `actualImagePath` — path to the Playwright-generated screenshot to compare.
- Generic policy: always provide paths explicitly via CLI args or calling code; no hardcoded image input paths.

## Outputs
- On success: JSON object with `similarity` (0–100) and `status` (`PASS`/`FAIL` or custom).
- On error: throws with a clear message indicating which file is missing or why validation failed.

## Trigger Phrase
- "Validate screen <TOM_ID>" or "Compare screenshot for TOM_01"

Execution Steps (Agent-driven)
1. Execution Agent produces a screenshot and writes an instruction JSON to `output/agents/figma-ops-<TOM_ID>.json` containing `expectedImagePath` and `actualImagePath`.
2. Figma Validator Agent reads the instruction, resolves both paths, runs the comparison, and writes the result to `output/agents/figma-result-<TOM_ID>.json`.

Expected Output
- `output/agents/figma-result-<TOM_ID>.json` with `{ similarity: <0-100>, status: 'PASS'|'FAIL' }` and optional `diffImage` path if a visual diff is produced.

Notes
- The comparator is intentionally pluggable. Integrate `pixelmatch`/`sharp` if pixel-diffing is required; until then the agent can operate in existence-only or simple-equality mode.

## Required skills
- Node.js `fs/promises` and `path` for path resolution and file checks
- Familiarity with image comparison libraries (if extending `compareImages`) such as `pixelmatch`, `resemblejs`, or `sharp` for preprocessing
- Error handling patterns and clear messaging for CI consumption
- Cross-platform path handling on Windows and POSIX
- GitHub Copilot (assistant) — included as a skill: the assistant can help integrate an image-diff library and tune thresholds for similarity

## Extensibility and maintenance
- To add pixel/structural comparisons, replace `compareImages()` with logic using `sharp` to read and normalize images and `pixelmatch` (or similar) to compute a diff and similarity score.
- Consider adding a `threshold` option and CLI flag to fail only if similarity < threshold.
- Add optional output of a visual diff image (e.g., `diff.png`) for debugging failures.

## Troubleshooting & notes
- The current `compareImages` implementation is a stub that returns `PASS`. If you need real image-diffing, I can integrate `pixelmatch` + `pngjs` or `sharp`.
- Ensure both expected and actual images are in the same pixel density and dimensions; otherwise comparisons should include resize/padding steps.
- For CI: store expected images in a locked location or artifact store and ensure the Playwright screenshots are captured consistently.

---
Would you like me to integrate a real image comparison implementation (e.g., using `pixelmatch` + `sharp`) and add a CLI `--threshold` flag? If yes, I will add required packages and a small test harness.