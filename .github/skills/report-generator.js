const fs = require('fs/promises');
const path = require('path');
// Excel/CSV outputs removed; keep minimal dependencies for JSON reporting.

function normalizeText(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeCsvCell(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}`;
    }
    return text;
}

function toReportRow(result = {}) {
    return {
        'TOM Number': normalizeText(result.testCaseId || result.TestCaseId || result.TOM_NUM),
        Journey: normalizeText(result.journey || result.userJourney || result.User_Journey),
        Status: normalizeText(result.status || result.Status),
        'Execution Time': normalizeText(result.executionTime || result.execution_time || result.ExecutionTime),
        Screenshot: normalizeText(result.screenshot || result.Screenshot || ''),
        'Failure Reason': normalizeText(result.reason || result.failureReason || result.FailureReason || '')
    };
}

async function ensureOutputDir(outputFilePath) {
    const dir = path.dirname(path.resolve(outputFilePath));
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

function buildCsv(rows) {
    const headers = ['TOM Number', 'Journey', 'Status', 'Execution Time', 'Screenshot', 'Failure Reason'];
    const lines = [headers.join(',')];

    for (const row of rows) {
        lines.push(headers.map((header) => escapeCsvCell(row[header])).join(','));
    }

    return `${lines.join('\n')}\n`;
}

// CSV and Excel report generation removed per updated output policy.
// We only emit per-test JSON files and a consolidated summary JSON.


async function writeExecutionSummary(rows, outputFilePath, options = {}) {
    await ensureOutputDir(outputFilePath);
    const totalFromResults = Array.isArray(rows) ? rows.length : 0;
    // Prefer explicit inputCount passed in options; fall back to results length
    const totalTOMs = Number.isFinite(Number(options.inputCount)) ? Number(options.inputCount) : totalFromResults;

    // single overall JSON written (1) or 0
    const overallJsonCreated = options.overallPath ? 1 : 0;
    const executionTime = options.executionTimeMs !== undefined ? `${options.executionTimeMs} ms` : (options.executionTime || 'n/a');

    const summary = {
        totalTOMs: totalTOMs,
        overallJsonCreated: overallJsonCreated,
        missingTOMs: Array.isArray(options.missingTOMs) ? options.missingTOMs : [],
        executionTime: executionTime
    };

    await fs.writeFile(path.resolve(outputFilePath), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return path.resolve(outputFilePath);
}

async function generateExecutionReport(results, options = {}) {
    const rows = (Array.isArray(results) ? results : [results]).filter(Boolean).map(toReportRow);
    const summaryPath = path.resolve(options.summaryPath || path.join('report', 'Execution_Summary.json'));

    // Determine expected TOMs from the provided input file (if available)
    let expectedToms = [];
    try {
        if (options.inputFilePath) {
            // require input-agent to read input testcases
            const inputAgent = require(path.resolve(__dirname, 'input-agent.js'));
            const parsed = await inputAgent.readInputTestcases(options.inputFilePath);
            expectedToms = Array.isArray(parsed) ? parsed.map(p => String(p.TOM_NUM || '').trim()).filter(Boolean) : [];
        }
    } catch (e) {
        expectedToms = [];
    }

    // Produced TOM ids from results
    const producedToms = (Array.isArray(results) ? results : [results]).map(r => String((r.testCaseId || r.TOM_NUM || r.TestCaseId) || '').trim()).filter(Boolean);
    const producedSet = new Set(producedToms);
    const missingTOMs = expectedToms.filter(t => !producedSet.has(String(t).trim()));

    // Ensure overall results file exists at options.overallPath or write one from results
    const overallPath = path.resolve(options.overallPath || path.join('output', 'TOM.json'));
    try {
        await ensureOutputDir(overallPath);
        await fs.writeFile(overallPath, JSON.stringify(Array.isArray(results) ? results : [results], null, 2), 'utf8');
    } catch (e) {
        // ignore write failure
    }

    // Write consolidated summary including missing TOMs
    await writeExecutionSummary(rows, summaryPath, {
        inputCount: expectedToms.length || options.inputCount,
        jsonFilesCreated: 1, // single overall JSON
        executionTimeMs: options.executionTimeMs,
        missingTOMs
    });

    return {
        overallPath,
        summaryPath,
        rows,
        missingTOMs
    };
}

function toExecutionJsonReport(result = {}) {
    return {
        testCaseId: normalizeText(result.testCaseId || result.TestCaseId || result.TOM_NUM),
        status: normalizeText(result.status || result.Status),
        screenshot: normalizeText(result.screenshot || result.Screenshot || ''),
        executionTime: normalizeText(result.executionTime || result.execution_time || result.ExecutionTime || new Date().toISOString())
    };
}

async function writeExecutionJsonReport(result, outputFilePath = path.join('output', 'execution-report.json')) {
    await ensureOutputDir(outputFilePath);
    const report = toExecutionJsonReport(result);
    // Attempt to name file after TOM/testCaseId when available
    let outPath = path.resolve(outputFilePath);
    try {
        const id = report.testCaseId || 'unknown';
        const dir = path.dirname(outPath);
        const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
        outPath = path.resolve(dir, `${safeId}-execution.json`);
    } catch (e) {}
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return outPath;
}

module.exports = {
    normalizeText,
    escapeCsvCell,
    toReportRow,
    generateExecutionReport,
    toExecutionJsonReport,
    writeExecutionJsonReport
};

if (require.main === module) {
    const inputPath = process.argv[2];
    const outputPath = process.argv[3] || process.env.OUTPUT_JSON || path.join('output', 'execution-report.json');

    (async () => {
        if (!inputPath) {
            throw new Error('Provide a JSON file containing execution results');
        }

        const content = await fs.readFile(inputPath, 'utf8');
        const results = JSON.parse(content);
            const baseDir = path.dirname(path.resolve(outputPath));
            const inputFilePath = process.argv[4] || null;
            const inputCount = process.argv[5] ? Number(process.argv[5]) : undefined;
            const executionTimeMs = process.argv[6] ? Number(process.argv[6]) : undefined;

            const report = await generateExecutionReport(results, {
                summaryPath: path.join(baseDir, 'Execution_Summary.json'),
                inputCount,
                executionTimeMs
            });

            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })().catch((error) => {
        process.stderr.write(`Report Generator Agent failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
