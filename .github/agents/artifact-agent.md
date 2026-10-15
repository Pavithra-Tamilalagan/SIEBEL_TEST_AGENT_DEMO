# Artifact Agent

> Skill module source is maintained in `.github/skills/artifact-agent.js`.

## Purpose
This agent documents and describes the runtime behavior of the artifact manager exported by `artifact-agent.js`. It does not treat the JS file as an input payload; instead the agent uses and documents the functions the module exposes for artifact path determination, directory creation, screenshot/video collection, and trace management.

## Location
File: .github/agents/artifact-agent.md

## Summary of operations
- Build safe, workspace-relative artifact paths for a given test-case id.
- Ensure artifact directories exist (`screenshots`, `test-results/<TOM>`, `test-results/<TOM>/video`).
- Provide a manager with methods to capture verification screenshots, failure screenshots, a final PASS/FAIL screenshot, collect video files, stop tracing and return trace paths, and produce a simple artifact summary.
- Provide a helper to return the primary screenshot path if it exists, or fail with a clear error.
- Generic policy: no hardcoded testcase id defaults in CLI mode; supply id as argument or env variable.

## Behavior / Algorithm (high level)
1. Normalize the test case id into a filesystem-safe token.
2. Compute absolute paths anchored at the workspace root for screenshots, traces and video output.
3. Create directories as needed with `fs.mkdir(..., { recursive: true })`.
4. Export a `createArtifactManager(testCaseId)` that returns an object with methods:
   - `captureVerificationScreenshot(page)` — saves numbered verify screenshots; first verification becomes the primary screenshot.
   - `captureFailureScreenshot(page)` — saves a dedicated failure image.
   - `captureFinalScreenshot(page, status)` — saves final PASS/FAIL image named `<TOM>-PASS.png` or `<TOM>-FAIL.png`.
   - `stopTrace(context)` — stops Playwright tracing and writes `trace.zip` to the test-results directory.
   - `collectVideoPath(page)` — copies / renames Playwright-recorded video to the agent's video path.
   - `getArtifactSummary(page, context)` — convenience summary with `screenshot`, `trace`, and `video` paths.
5. Export small utilities `normalizeTestCaseId`, `isVerificationStep`, and `getArtifactPaths` for external use.

## Inputs
- `testCaseId` (string) — identifier used to scope artifact folders and filenames.
- Playwright `page` and `context` objects are passed into methods that capture screenshots, collect video, or stop traces.

## Outputs
- Files written under the workspace:
  - `screenshots/<TOM>.png` (primary verification screenshot)
  - `screenshots/<TOM>-PASS.png` or `screenshots/<TOM>-FAIL.png` (final)
  - `test-results/<TOM>/trace.zip` (Playwright trace)
  - `test-results/<TOM>/video/video.webm` (copied/renamed video)
- Methods return absolute paths to the created artifacts.

## Trigger Phrase
- "Collect artifacts for <TOM_ID>" or "Get artifacts for TOM_01"

Execution Steps (Agent-driven)
1. Execution Agent requests artifact operations for `TOM_ID` when a verification or failure occurs.
2. Artifact Agent creates/ensures directories under `output/artifacts/<TOM_ID>/` and `screenshots/`.
3. Artifact Agent saves verification/failure/final screenshots, and records locations for trace and video paths.
4. Artifact Agent returns an artifact summary JSON to `output/agents/artifact-summary-<TOM_ID>.json`.

Agent-to-Agent Communication
- Execution Agent signals Artifact Agent by writing a small instruction JSON to `output/agents/artifact-ops-<TOM_ID>.json` (fields: `op: 'capture'|'finalize'`, `testCaseId`, `context`).
- Artifact Agent processes the instruction, writes artifacts and the summary JSON file for Report Generator to consume.

Expected Output
- `output/artifacts/<TOM_ID>/` folder with screenshots, `trace.zip` and `video.webm` where available.
- `output/agents/artifact-summary-<TOM_ID>.json` with `screenshot`, `trace`, `video` paths and final `status`.

## Required skills
- Node.js async `fs/promises` file and directory operations
- Path manipulation with `path.resolve` and cross-platform separators
- Playwright artifact handling: `page.screenshot()`, `page.video()`, `context.tracing.stop()`
- Defensive file operations (copy vs rename fallbacks)
- Workspace layout awareness and stable naming conventions
- GitHub Copilot (assistant) — included as a skill: the assistant can help extend artifact naming, add S3/remote upload hooks, or add retention policies

## Troubleshooting & notes
- Ensure Node.js has write permission to the workspace directories; run with appropriate user or elevated privileges if permission errors occur.
- If `collectVideoPath()` returns `null`, Playwright may not have recorded video for the given context—verify that `recordVideo` was enabled when creating the context.
- If `stopTrace()` fails, ensure the trace was started via `context.tracing.start(...)` before calling stop.
- On Windows, path separators are normalized to forward slashes in returned relative paths to aid consumption by CI steps.

## Maintenance
- To add remote upload (S3, Azure) hook: extend `getArtifactSummary()` to optionally call an uploader before returning.
- To change file naming conventions, update `getArtifactPaths()` and `normalizeTestCaseId()`.

---
I can now:
- Add an example wrapper script that uses `createArtifactManager()` end-to-end, or
- Add a GitHub Action that archives artifacts after the execution agent runs.

Which would you like next?