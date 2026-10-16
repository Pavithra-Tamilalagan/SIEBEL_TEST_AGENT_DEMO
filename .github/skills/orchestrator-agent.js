require('dotenv').config({ path: '.env.local' });

const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
// Agents are treated as autonomous CLI processes. The orchestrator coordinates them
// by invoking their Node CLI entrypoints instead of requiring their modules.

function normalizePath(filePath) {
    return path.resolve(String(filePath || '').trim());
}

function getFileExtension(filePath) {
    return path.extname(String(filePath || '')).toLowerCase();
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// Append a timestamped line to the orchestrator log (output/orchestrator.log)
async function appendOrchLog(line) {
    try {
        const outDir = path.resolve(__dirname, '..', '..', 'output');
        await fs.mkdir(outDir, { recursive: true });
        const logPath = path.resolve(outDir, 'orchestrator.log');
        const ts = (new Date()).toISOString();
        await fs.appendFile(logPath, `${ts} ${String(line || '')}\n`, 'utf8');
    } catch (e) {
        // best-effort
        try { console.error('Failed to write orchestrator log', e && e.message); } catch (e) {}
    }
}

function captureProcOutput(tag, proc) {
    const out = String(proc.stdout || '').trim();
    const err = String(proc.stderr || '').trim();
    return { out, err, tag };
}

/**
 * Update the input Excel/CSV by adding/updating Result, Failure_Reason, Result_Image columns
 * Saves a new workbook named <original_basename>_results.xlsx next to the input file.
 * Only updates rows matching provided results array (by TOM Number).
 */
async function updateInputWorkbook(inputPath, resultsArray) {
    if (!inputPath) return;
    const ext = getFileExtension(inputPath);
    const resultsByTom = Object.fromEntries((resultsArray || []).map(r => [String(r.testCaseId || r.TOM || '').trim(), r]));

    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(inputPath);
        const ws = wb.worksheets[0];
        const headerRow = ws.getRow(1);
        const headers = [];
        headerRow.eachCell((cell, colNumber) => { headers[colNumber] = String(cell.value || '').trim(); });

        const ensureColumn = (name) => {
            const existing = headers.findIndex(h => String(h).toUpperCase() === String(name).toUpperCase());
            if (existing > 0) return existing;
            const newCol = headers.length + 1;
            ws.getRow(1).getCell(newCol).value = name;
            headers[newCol] = name;
            return newCol;
        };

        const colResult = ensureColumn('Result');
        const colFailure = ensureColumn('Failure_Reason');
        const colImage = ensureColumn('Result_Image');

        // iterate rows and update matching TOMs
        for (let r = 2; r <= ws.rowCount; r++) {
            const row = ws.getRow(r);
            // find TOM_NUM header column (headers array is 1-based index)
            let tomColIndex = -1;
            for (let i = 1; i < headers.length; i++) {
                if (String(headers[i] || '').toUpperCase() === 'TOM_NUM') { tomColIndex = i; break; }
            }
            if (tomColIndex === -1) tomColIndex = 1;
            const tomVal = String(row.getCell(tomColIndex).value || '').trim();
            const res = resultsByTom[tomVal];
            if (res) {
                row.getCell(colResult).value = res.status || '';
                row.getCell(colFailure).value = res.reason || '';
                // store relative screenshot path when possible
                row.getCell(colImage).value = res.screenshot ? String(res.screenshot).replace(/\\/g, '/') : '';
                row.commit();
            }
        }

        const outPath = path.resolve(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}_results.xlsx`);
        await wb.xlsx.writeFile(outPath);
        console.log('Updated input workbook saved to:', outPath);
        return outPath;
    }

    // For CSV inputs, write a new Excel results workbook combining CSV rows and results
    if (ext === '.csv') {
        const rows = await readTestcasesFromFile(inputPath);
        const wb2 = new ExcelJS.Workbook();
        const sheet = wb2.addWorksheet('Execution Results');
        // build headers from first row keys + result columns
        const first = rows[0] || {};
        const headers = Object.keys(first);
        const cols = headers.map(h => ({ header: h, key: h }));
        cols.push({ header: 'Result', key: 'Result' }, { header: 'Failure_Reason', key: 'Failure_Reason' }, { header: 'Result_Image', key: 'Result_Image' });
        sheet.columns = cols;
        for (const r of rows) {
            const res = resultsByTom[String(r.TOM_NUM || '').trim()];
            sheet.addRow({ ...r, Result: res ? res.status : '', Failure_Reason: res ? res.reason : '', Result_Image: res ? (res.screenshot || '') : '' });
        }
        const outPath = path.resolve(path.dirname(inputPath), `Execution_Results.xlsx`);
        await wb2.xlsx.writeFile(outPath);
        console.log('Wrote CSV->Excel results workbook:', outPath);
        return outPath;
    }

    return null;
}

async function readExcelTestcases(xlsxFilePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxFilePath);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
        return [];
    }

    const headers = [];
    const firstRow = worksheet.getRow(1);
    firstRow.eachCell((cell, colNumber) => {
        headers[colNumber] = String(cell.value || '').trim();
    });

    const headerIndex = Object.fromEntries(
        headers.filter(Boolean).map((header, index) => [header, index + 1])
    );

    const required = ['TOM_NUM', 'User_Journey', 'Order_Steps', 'Post_Verification'];
    const missing = required.filter((header) => !headerIndex[header]);
    if (missing.length > 0) {
        throw new Error(`Missing required column(s) in Excel file: ${missing.join(', ')}`);
    }

    const rows = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const record = {
            TOM_NUM: String(row.getCell(headerIndex.TOM_NUM).value || '').trim(),
            User_Journey: String(row.getCell(headerIndex.User_Journey).value || '').trim(),
            Order_Steps: String(row.getCell(headerIndex.Order_Steps).value || '').trim(),
            Post_Verification: String(row.getCell(headerIndex.Post_Verification).value || '').trim()
        };

        if (Object.values(record).some((value) => value)) {
            rows.push(record);
        }
    }

    return rows;
}

async function readTestcasesFromFile(inputFilePath) {
    // Delegate reading/parsing to the input-agent CLI so the agent is autonomous.
    const resolved = normalizePath(inputFilePath);
    const inputAgentPath = path.resolve(__dirname, 'input-agent.js');
    const node = process.execPath;
    const args = [inputAgentPath, resolved];
    await appendOrchLog('[STEP 1] Input Agent Started');
    const proc = spawnSync(node, args, { encoding: 'utf8' });
    const captured = captureProcOutput('input-agent', proc);
    await appendOrchLog(`[STEP 1] input-agent stdout:\n${captured.out}`);
    if (captured.err) await appendOrchLog(`[STEP 1] input-agent stderr:\n${captured.err}`);
    if (proc.error) {
        await appendOrchLog(`[STEP 1] input-agent spawn error: ${proc.error.message}`);
        throw proc.error;
    }
    if (proc.status !== 0) {
        await appendOrchLog(`[STEP 1] input-agent exited non-zero: ${proc.status}`);
        throw new Error(`input-agent failed: ${captured.err || 'unknown error'}`);
    }
    try {
        const parsed = JSON.parse(proc.stdout || '[]');
        await appendOrchLog('[STEP 1] Input Agent Completed');
        return parsed;
    } catch (e) {
        await appendOrchLog(`[STEP 1] Failed to parse input-agent JSON: ${e.message}`);
        throw new Error(`Failed to parse input-agent output: ${e.message}`);
    }
}

// Run the playwright generator CLI, pointing at the parsed JSON file and optional outDir
async function runPlaywrightGenerator(inputJsonPath, outDir) {
    await appendOrchLog('[STEP 2] Playwright Generator Started');
    const node = process.execPath;
    const genPath = path.resolve(__dirname, 'playwright-generator.js');
    const args = [genPath, inputJsonPath, '--all'];
    if (outDir) args.push('--out-dir', outDir);
    const proc = spawnSync(node, args, { encoding: 'utf8' });
    const captured = captureProcOutput('playwright-generator', proc);
    await appendOrchLog(`[STEP 2] playwright-generator stdout:\n${captured.out}`);
    if (captured.err) await appendOrchLog(`[STEP 2] playwright-generator stderr:\n${captured.err}`);
    if (proc.error) {
        await appendOrchLog(`[STEP 2] playwright-generator spawn error: ${proc.error.message}`);
        throw proc.error;
    }
    if (proc.status !== 0) {
        await appendOrchLog(`[STEP 2] playwright-generator exited non-zero: ${proc.status}`);
        throw new Error(`playwright-generator failed: ${captured.err || 'unknown error'}`);
    }
    await appendOrchLog('[STEP 2] Playwright Generator Completed');
    return { stdout: captured.out, stderr: captured.err };
}

function resolveExpectedFigmaImage(testCaseId, options = {}) {
    if (options.expectedImagePath) {
        return normalizePath(options.expectedImagePath);
    }

    if (options.expectedImageDir) {
        return path.resolve(normalizePath(options.expectedImageDir), `${testCaseId}.png`);
    }

    const defaultPath = path.resolve(__dirname, '..', '..', 'figma', `${testCaseId}.png`);
    return defaultPath;
}

function parseTomNumber(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const match = raw.match(/(?:TOM[_-]?)?(\d+)/i);
    if (!match) return 0;
    return Number.parseInt(match[1], 10) || 0;
}

function normalizeTomId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/(?:TOM[_-]?)?(\d+)/i);
    if (!match) return raw.toUpperCase();
    const tomNum = Number.parseInt(match[1], 10);
    return `TOM_${String(tomNum).padStart(2, '0')}`;
}

function parseTomSelection(selector = '') {
    const raw = String(selector || '').trim();
    if (!raw || /^(all|--all)$/i.test(raw)) return [];

    const entries = raw
        .split(/[;,\s]+/)
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);

    const selected = new Set();
    for (const entry of entries) {
        if (!entry || entry === ',') continue;

        if (entry.includes('-')) {
            const parts = entry.split('-').map((part) => String(part || '').trim()).filter(Boolean);
            if (parts.length === 2) {
                const start = parseTomNumber(parts[0]);
                const end = parseTomNumber(parts[1]);
                const begin = Math.min(start, end);
                const finish = Math.max(start, end);
                for (let num = begin; num <= finish; num += 1) {
                    selected.add(normalizeTomId(num));
                }
                continue;
            }
        }

        selected.add(normalizeTomId(entry));
    }

    return Array.from(selected).sort((a, b) => parseTomNumber(a) - parseTomNumber(b));
}

async function runFullAutomation(testCaseId = '', inputFilePath, options = {}) {
    const resolvedInput = inputFilePath || process.env.INPUT_CSV;

    if (!resolvedInput) {
        throw new Error('Input CSV/Excel file path is required');
    }

    const inputStart = Date.now();
    // STEP 1: run input-agent to get parsed testcases (and log its output)
    const testcases = await readTestcasesFromFile(resolvedInput);
    // write parsed JSON to output for generator consumption
    const parsedJsonPath = path.resolve(__dirname, '..', '..', 'output', `parsed_testcases_${Date.now()}.json`);
    await fs.mkdir(path.dirname(parsedJsonPath), { recursive: true });
    await fs.writeFile(parsedJsonPath, JSON.stringify(testcases, null, 2), 'utf8');
    await appendOrchLog(`[STEP 1] Parsed testcases written to ${parsedJsonPath}`);
    if (!testcases.length) {
        throw new Error('No test cases found in the input file');
    }

    // STEP 2: invoke playwright-generator CLI to generate specs from parsed JSON
    const genOutDir = path.resolve(__dirname, '..', '..', 'output', 'generated-playwright');
    try {
        await runPlaywrightGenerator(parsedJsonPath, genOutDir);
    } catch (e) {
        await appendOrchLog(`[STEP 2] Playwright generator failed: ${e && e.message}`);
        throw e;
    }
    // validate generated spec dir
    try {
        const entries = await fs.readdir(genOutDir);
        if (!entries || entries.length === 0) {
            await appendOrchLog(`[STEP 2] No generated spec files found in ${genOutDir}`);
            // not fatal: continue but warn
        } else {
            await appendOrchLog(`[STEP 2] Generated spec files in ${genOutDir}: ${entries.join(', ')}`);
        }
    } catch (e) {
        await appendOrchLog(`[STEP 2] Warning: failed to list generated spec dir ${genOutDir}: ${e && e.message}`);
    }

    const normalizedTestCaseId = testCaseId ? String(testCaseId).trim() : '';
    const requestedTomIds = parseTomSelection(normalizedTestCaseId);
    const selectedTestcases = requestedTomIds.length
        ? testcases.filter((testcase) => requestedTomIds.includes(normalizeTomId(testcase.TOM_NUM)))
        : testcases;

    if (normalizedTestCaseId && requestedTomIds.length && !selectedTestcases.length) {
        throw new Error(`No test cases matched selection: ${normalizedTestCaseId}`);
    }

    const results = [];
    const agentTimings = [{ agent: 'input-agent', testcase: 'ALL', durationMs: Date.now() - inputStart }];
    // If a specific TOM was provided, execute only that TOM. If not provided, execute all TOMs from the input file.
    const totalStart = Date.now();

    if (normalizedTestCaseId && requestedTomIds.length === 1) {
        const matchedInput = testcases.find((testcase) => normalizeTomId(testcase.TOM_NUM) === requestedTomIds[0]);
        if (!matchedInput) {
            throw new Error(`Test case ${normalizedTestCaseId} not found in input file`);
        }

        // Execute the case by invoking the execution-agent as an autonomous process.
        // The execution-agent will read the input file, build the execution case and run it.
        // For single TOM runs, run execution-agent but tolerate non-zero exit (log outputs)
        const startTime = Date.now();
        const nodePath = process.execPath;
        const execAgent = path.resolve(__dirname, 'execution-agent.js');
        await appendOrchLog('[STEP 3] Execution Started for ' + normalizedTestCaseId);
        const execProc = spawnSync(nodePath, [execAgent, normalizedTestCaseId, resolvedInput], { encoding: 'utf8' });
        const capturedExec = captureProcOutput('execution-agent', execProc);
        await appendOrchLog(`[STEP 3] execution-agent stdout:\n${capturedExec.out}`);
        if (capturedExec.err) await appendOrchLog(`[STEP 3] execution-agent stderr:\n${capturedExec.err}`);
        let executionResult = {};
        if (execProc.error) {
            await appendOrchLog(`[STEP 3] execution-agent spawn error: ${execProc.error.message}`);
            executionResult = { status: 'FAIL', testCaseId: normalizedTestCaseId, reason: execProc.error.message };
        } else if (execProc.status !== 0) {
            // Try to parse stdout even when exit is non-zero
            try {
                const txt = String(execProc.stdout || '');
                try { executionResult = JSON.parse(txt); } catch (e) {
                    const m = txt.match(/\{[\s\S]*\}\s*$/);
                    if (m) executionResult = JSON.parse(m[0]); else throw e;
                    await appendOrchLog(`[STEP 3] Failed to parse execution-agent JSON for ${normalizedTestCaseId}: ${e.message}`);
                    await appendOrchLog(`[STEP 3] Raw execution-agent stdout:\n${String(execProc.stdout || '')}`);
                    console.error('Failed to parse execution-agent JSON (single):', e && e.message);
                    throw e;
                }
            } catch (e) {
                executionResult = { status: 'FAIL', testCaseId: normalizedTestCaseId, reason: capturedExec.err || String(e.message || e) };
            }
        } else {
            try {
                const txt = String(execProc.stdout || '');
                try { executionResult = JSON.parse(txt); } catch (e) {
                    const m = txt.match(/\{[\s\S]*\}\s*$/);
                    if (m) executionResult = JSON.parse(m[0]); else throw e;
                }
            } catch (e) {
                await appendOrchLog(`[STEP 3] Failed to parse execution-agent JSON: ${e.message}`);
                throw new Error(`Failed to parse execution-agent output: ${e.message}`);
            }
        }
        await appendOrchLog('[STEP 3] Execution Completed for ' + normalizedTestCaseId);
        const executionMs = Date.now() - startTime;
        const executionTime = `${executionMs} ms`;
        agentTimings.push({ agent: 'execution-agent', testcase: normalizedTestCaseId, durationMs: executionMs });

        let similarity = null;
        let finalStatus = executionResult.status;
        let failureReason = executionResult.reason || '';
        const expectedFigmaImage = resolveExpectedFigmaImage(normalizedTestCaseId, options);

        if (executionResult.screenshot && await fileExists(expectedFigmaImage)) {
                try {
                // Delegate validation to figma-validator CLI
                const figmaAgent = path.resolve(__dirname, 'figma-validator.js');
                const figStart = Date.now();
                const figProc = spawnSync(nodePath, [figmaAgent, expectedFigmaImage, executionResult.screenshot], { encoding: 'utf8' });
                if (figProc.error) throw figProc.error;
                if (figProc.status !== 0) {
                    throw new Error(`figma-validator failed: ${figProc.stderr}`);
                }
                const figmaResult = JSON.parse(figProc.stdout || '{}');
                agentTimings.push({ agent: 'figma-validator', testcase: normalizedTestCaseId, durationMs: Date.now() - figStart });
                similarity = figmaResult.similarity;
                if (figmaResult.status !== 'PASS') {
                    finalStatus = 'FAIL';
                    failureReason = failureReason || `Figma similarity below threshold: ${similarity}%`;
                }
            } catch (error) {
                finalStatus = 'FAIL';
                failureReason = failureReason || `Figma validation failed: ${error.message}`;
            }
        }

        const resultRow = {
            testCaseId: executionResult.testCaseId || matchedInput.TOM_NUM,
            journey: matchedInput.User_Journey,
            status: finalStatus,
            executionTime,
            screenshot: executionResult.screenshot || '',
            trace: executionResult.trace || '',
            video: executionResult.video || '',
            reason: failureReason,
            script: executionResult.script || '',
            similarity
        };

        // If input is an Excel file, write a results workbook next to it
        try {
            const inputExt = path.extname(resolvedInput || '').toLowerCase();
            if (inputExt === '.xlsx' || inputExt === '.xlsm' || inputExt === '.xls') {
                const resultWorkbookPath = path.resolve(path.dirname(resolvedInput), `${path.basename(resolvedInput, path.extname(resolvedInput))}_results.xlsx`);
                const wb = new ExcelJS.Workbook();
                const sheet = wb.addWorksheet('Automated Results');
                sheet.columns = [
                    { header: 'TOM Number', key: 'TOM', width: 14 },
                    { header: 'Journey', key: 'Journey', width: 45 },
                    { header: 'Status', key: 'Status', width: 12 },
                    { header: 'Execution Time', key: 'ExecutionTime', width: 18 },
                    { header: 'Screenshot', key: 'Screenshot', width: 60 },
                    { header: 'Failure Reason', key: 'FailureReason', width: 60 }
                ];
                sheet.addRow({ TOM: resultRow.testCaseId, Journey: resultRow.journey, Status: resultRow.status, ExecutionTime: resultRow.executionTime, Screenshot: resultRow.screenshot, FailureReason: resultRow.reason });
                await wb.xlsx.writeFile(resultWorkbookPath);
                console.log('Wrote results workbook:', resultWorkbookPath);
            }
        } catch (e) {
            console.warn('Failed to write input results workbook', e && e.message);
        }

                // Produce reports by invoking the report-generator CLI with the results JSON
                const tmpResultsPath = path.resolve(__dirname, '..', '..', 'output', `${normalizedTestCaseId || 'results'}.json`);
                await fs.mkdir(path.dirname(tmpResultsPath), { recursive: true });
                await fs.writeFile(tmpResultsPath, JSON.stringify([resultRow], null, 2), 'utf8');
                const reportAgent = path.resolve(__dirname, 'report-generator.js');
                const reportStart = Date.now();
                const reportJsonOut = path.resolve(__dirname, '..', '..', 'output', `${normalizedTestCaseId || 'result'}-execution-report.json`);
                // compute elapsed time so far to include in summary
                const totalExecutionTimeMs = Date.now() - totalStart;
                const reportProc = spawnSync(nodePath, [reportAgent, tmpResultsPath, reportJsonOut, resolvedInput, String(testcases.length), String(totalExecutionTimeMs)], { encoding: 'utf8' });
                // capture report-generator output
                const capturedReport = captureProcOutput('report-generator', reportProc);
                await appendOrchLog('[STEP 4] Report Generation Started');
                await appendOrchLog(`[STEP 4] report-generator stdout:\n${capturedReport.out}`);
                if (capturedReport.err) await appendOrchLog(`[STEP 4] report-generator stderr:\n${capturedReport.err}`);
                if (reportProc.error) throw reportProc.error;
                if (reportProc.status !== 0) {
                    throw new Error(`report-generator failed: ${capturedReport.err}`);
                }
                let report = {};
                try { report = JSON.parse(reportProc.stdout || '{}'); } catch (e) { report = {}; }
                await appendOrchLog('[STEP 4] Report Generation Completed');
                agentTimings.push({ agent: 'report-generator', testcase: normalizedTestCaseId, durationMs: Date.now() - reportStart });
                const totalEnd = Date.now();
                const totalExecutionTime = `${totalEnd - totalStart} ms`;

                // Update original input workbook with results columns
                try {
                    await updateInputWorkbook(resolvedInput, [resultRow]);
                } catch (e) {
                    console.warn('Failed to update input workbook with results', e && e.message);
                }

                return {
                    total: 1,
                    passed: resultRow.status === 'PASS' ? 1 : 0,
                    failed: resultRow.status === 'PASS' ? 0 : 1,
                    executionTime: totalExecutionTime,
                    results: [resultRow],
                    report: report.overallPath || path.join('output', 'TOM.json'),
                    parsedJson: parsedJsonPath,
                    generatedSpecsDir: genOutDir,
                    orchestratorLog: path.resolve(__dirname, '..', '..', 'output', 'orchestrator.log'),
                    agentTimings
                };
    }

    // No specific TOM passed: execute all testcases sequentially and collect results.
    // This branch also executes multi-TOM selections such as TOM_02-TOM_10.
    const nodePath = process.execPath;
    for (const row of selectedTestcases) {
        const caseId = String(row.TOM_NUM || '').trim();
        if (!caseId) continue;

        let executionResult = { status: 'FAIL', testCaseId: caseId, screenshot: '', trace: '', video: '', reason: 'Failed to build execution case' };
        let executionTime = '0 ms';
        try {
            const startTime = Date.now();
            const execAgent = path.resolve(__dirname, 'execution-agent.js');
            await appendOrchLog('[STEP 3] Execution Started for ' + caseId);
            const execProc = spawnSync(nodePath, [execAgent, caseId, resolvedInput], { encoding: 'utf8' });
            const capturedExec = captureProcOutput('execution-agent', execProc);
            await appendOrchLog(`[STEP 3] execution-agent stdout for ${caseId}:\n${capturedExec.out}`);
            if (capturedExec.err) await appendOrchLog(`[STEP 3] execution-agent stderr for ${caseId}:\n${capturedExec.err}`);
            if (execProc.error) {
                await appendOrchLog(`[STEP 3] execution-agent spawn error for ${caseId}: ${execProc.error.message}`);
                throw execProc.error;
            }
            // tolerant parsing
            const outTxt = String(execProc.stdout || '');
            try {
                try { executionResult = JSON.parse(outTxt); } catch (e) {
                    const m = outTxt.match(/\{[\s\S]*\}\s*$/);
                    if (m) executionResult = JSON.parse(m[0]); else throw e;
                }
            } catch (e) {
                // mark as fail but continue; log raw stdout for diagnosis
                await appendOrchLog(`[STEP 3] Failed to parse execution-agent JSON for ${caseId}: ${e.message}`);
                await appendOrchLog(`[STEP 3] Raw execution-agent stdout for ${caseId}:\n${String(capturedExec.out || '')}`);
                console.error('Failed to parse execution-agent JSON for', caseId, e && e.message);
                executionResult = { status: 'FAIL', testCaseId: caseId, reason: capturedExec.err || String(e.message || e) };
            }
            const executionMs = Date.now() - startTime;
            executionTime = `${executionMs} ms`;
            agentTimings.push({ agent: 'execution-agent', testcase: caseId, durationMs: executionMs });
            await appendOrchLog('[STEP 3] Execution Completed for ' + caseId);
        } catch (err) {
            executionResult = executionResult || {};
            executionResult.status = 'FAIL';
            executionResult.testCaseId = caseId;
            executionResult.reason = (err && err.message) ? err.message : String(err);
            await appendOrchLog(`[STEP 3] Execution error for ${caseId}: ${executionResult.reason}`);
        }

        let similarity = null;
        let finalStatus = executionResult.status || 'FAIL';
        let failureReason = executionResult.reason || '';
        const expectedFigmaImage = resolveExpectedFigmaImage(caseId, options);

        if (executionResult.screenshot && await fileExists(expectedFigmaImage)) {
            try {
                const figmaAgent = path.resolve(__dirname, 'figma-validator.js');
                const figStart = Date.now();
                const figProc = spawnSync(nodePath, [figmaAgent, expectedFigmaImage, executionResult.screenshot], { encoding: 'utf8' });
                if (figProc.error) throw figProc.error;
                if (figProc.status !== 0) {
                    throw new Error(`figma-validator failed: ${figProc.stderr}`);
                }
                const figmaResult = JSON.parse(figProc.stdout || '{}');
                agentTimings.push({ agent: 'figma-validator', testcase: caseId, durationMs: Date.now() - figStart });
                similarity = figmaResult.similarity;
                if (figmaResult.status !== 'PASS') {
                    finalStatus = 'FAIL';
                    failureReason = failureReason || `Figma similarity below threshold: ${similarity}%`;
                }
            } catch (error) {
                finalStatus = 'FAIL';
                failureReason = failureReason || `Figma validation failed: ${error.message}`;
            }
        }

        const resultRow = {
            testCaseId: executionResult.testCaseId || caseId,
            journey: row.User_Journey,
            status: finalStatus,
            executionTime,
            screenshot: executionResult.screenshot || '',
            trace: executionResult.trace || '',
            video: executionResult.video || '',
            reason: failureReason,
            script: executionResult.script || '',
            similarity
        };

        results.push(resultRow);
    }

    // If input is an Excel file, write a results workbook next to it
    try {
        const inputExt = path.extname(resolvedInput || '').toLowerCase();
        if (inputExt === '.xlsx' || inputExt === '.xlsm' || inputExt === '.xls') {
            const resultWorkbookPath = path.resolve(path.dirname(resolvedInput), `${path.basename(resolvedInput, path.extname(resolvedInput))}_results.xlsx`);
            const wb = new ExcelJS.Workbook();
            const sheet = wb.addWorksheet('Automated Results');
            sheet.columns = [
                { header: 'TOM Number', key: 'TOM', width: 14 },
                { header: 'Journey', key: 'Journey', width: 45 },
                { header: 'Status', key: 'Status', width: 12 },
                { header: 'Execution Time', key: 'ExecutionTime', width: 18 },
                { header: 'Screenshot', key: 'Screenshot', width: 60 },
                { header: 'Failure Reason', key: 'FailureReason', width: 60 }
            ];
            for (const r of results) {
                sheet.addRow({ TOM: r.testCaseId || r.TOM_NUM || '', Journey: r.journey || r.User_Journey || '', Status: r.status || '', ExecutionTime: r.executionTime || '', Screenshot: r.screenshot || '', FailureReason: r.reason || '' });
            }
            await wb.xlsx.writeFile(resultWorkbookPath);
            console.log('Wrote results workbook:', resultWorkbookPath);
        }
    } catch (e) {
        console.warn('Failed to write input results workbook', e && e.message);
    }

    // Update original workbook (or produce an updated workbook) with Result columns
    try {
        await updateInputWorkbook(resolvedInput, results);
    } catch (e) {
        console.warn('Failed to update input workbook with results', e && e.message);
    }

    // Write results to a temp file and delegate report generation to the report-generator CLI
    await fs.mkdir(path.resolve('output'), { recursive: true });
    const tmpAllResults = path.resolve(__dirname, '..', '..', 'output', `all_results_${Date.now()}.json`);
    await fs.writeFile(tmpAllResults, JSON.stringify(results, null, 2), 'utf8');
    const node = process.execPath;
    const reportStart = Date.now();
    const reportAgent = path.resolve(__dirname, 'report-generator.js');
    const reportJsonOut = path.resolve(__dirname, '..', '..', 'output', 'execution-report.json');
    // compute elapsed time so far to include in summary
    const totalExecutionTimeMs = Date.now() - totalStart;
    const reportProc = spawnSync(node, [reportAgent, tmpAllResults, reportJsonOut, resolvedInput, String(selectedTestcases.length || testcases.length), String(totalExecutionTimeMs)], { encoding: 'utf8' });
    if (reportProc.error) throw reportProc.error;
    if (reportProc.status !== 0) {
        throw new Error(`report-generator failed: ${reportProc.stderr}`);
    }
    let report = {};
    try { report = JSON.parse(reportProc.stdout || '{}'); } catch (e) { report = {}; }
    agentTimings.push({ agent: 'report-generator', testcase: normalizedTestCaseId || 'ALL', durationMs: Date.now() - reportStart });

    const total = results.length;
    const passed = results.filter((r) => String(r.status).toUpperCase() === 'PASS').length;
    const failed = total - passed;
    const totalEnd = Date.now();
    const totalExecutionTime = `${totalEnd - totalStart} ms`;

    return {
        total,
        passed,
        failed,
        executionTime: totalExecutionTime,
        results,
        report: report.overallPath || path.join('output', 'TOM.json'),
        parsedJson: parsedJsonPath,
        generatedSpecsDir: genOutDir,
        orchestratorLog: path.resolve(__dirname, '..', '..', 'output', 'orchestrator.log'),
        agentTimings
    };
}

module.exports = {
    normalizePath,
    getFileExtension,
    fileExists,
    readExcelTestcases,
    readTestcasesFromFile,
    resolveExpectedFigmaImage,
    parseTomSelection,
    normalizeTomId,
    runFullAutomation
};

if (require.main === module) {
    let testCaseId = process.argv[2] || '';
    const inputFile = process.argv[3] || process.env.INPUT_CSV;
    // Allow callers to pass 'all' or '--all' to indicate execute all TOMs
    if (testCaseId && String(testCaseId).toLowerCase() === 'all') testCaseId = '';
    if (testCaseId && String(testCaseId).toLowerCase() === '--all') testCaseId = '';
    if (!inputFile) {
        process.stderr.write('Usage: node .github/skills/orchestrator-agent.js [TOM_ID|TOM_RANGE|all] <INPUT_CSV_OR_XLSX>\nExamples:\n  TOM_01\n  TOM_02-TOM_10\n  TOM_02,TOM_05,TOM_09\nProvide input file path as second argument or set INPUT_CSV env var.\n');
        process.exitCode = 2;
    } else {
        runFullAutomation(testCaseId, inputFile)
            .then((output) => {
            try {
                // Print a concise human-readable summary
                const total = output.total || 0;
                const passed = output.passed || 0;
                const failed = output.failed || 0;
                const execTime = output.executionTime || output.executionTime || 'n/a';
                const reportPath = output.report || output.results && output.results[0] && output.results[0].report || 'n/a';
                console.log('--- Orchestrator Summary ---');
                console.log('Total TOMs:', total);
                console.log('Passed:', passed);
                console.log('Failed:', failed);
                console.log('Execution Time:', execTime);
                console.log('Report Location:', reportPath);
            } catch (e) {}
            process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
            })
            .catch((error) => {
                process.stderr.write(`Orchestrator Agent failed: ${error.message}\n`);
                process.exitCode = 1;
            });
    }
}
