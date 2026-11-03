const fs = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.local'), quiet: true }); } catch (e) { /* optional */ }

function cellText(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map((t) => t.text).join('');
        if (v.text !== undefined) return String(v.text);
        if (v.result !== undefined) return String(v.result);
    }
    return String(v);
}

/**
 * Locate the test-data workbook. Priority: TEST_DATA_XLSX env var, then any
 * input/*Data*.xlsx file (excluding result workbooks).
 */
async function findTestDataWorkbook(inputDir) {
    if (process.env.TEST_DATA_XLSX) {
        const p = path.resolve(inputDir, path.basename(process.env.TEST_DATA_XLSX));
        try { await fs.access(p); return p; } catch { /* fall through */ }
    }
    try {
        const files = await fs.readdir(inputDir);
        const hit = files.find((f) => /data/i.test(f) && /\.xlsx$/i.test(f) && !/result/i.test(f) && !f.startsWith('~$'));
        return hit ? path.resolve(inputDir, hit) : null;
    } catch {
        return null;
    }
}

const ENV_ALIASES = {
    ENV_URL: ['BASE_URL'],
    ENV_USERNAME: ['SIEBEL_USERNAME'],
    ENV_PASSWORD: ['SIEBEL_PASSWORD'],
    CUSTOMER_FIRST_NAME: ['FIRST_NAME'],
    CUSTOMER_LAST_NAME: ['LAST_NAME']
};
// Credentials/URL stay as {{TOKENS}} in step text so they are never written to logs/JSON;
// the generator's login block reads them from the environment at runtime.
const SECRET_TOKENS = /^(ENV_URL|ENV_USERNAME|ENV_PASSWORD)$/;

function resolveDataValue(raw) {
    const value = cellText(raw).trim();
    const envRef = value.match(/^\.env:(\w+)$/i);
    if (envRef) {
        const keys = [envRef[1], ...(ENV_ALIASES[envRef[1]] || [])];
        const hit = keys.find((k) => process.env[k] !== undefined && process.env[k] !== '');
        return hit ? process.env[hit] : undefined;
    }
    return value;
}

function sheetRows(ws) {
    if (!ws) return [];
    const headers = [];
    ws.getRow(1).eachCell((cell, c) => { headers[c] = cellText(cell.value).trim(); });
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r += 1) {
        const row = ws.getRow(r);
        const obj = {};
        headers.forEach((h, c) => { if (h) obj[h] = row.getCell(c).value; });
        rows.push(obj);
    }
    return rows;
}

/**
 * Load data workbook into { common: {PARAM: value}, perTom: {TOM_NN: {PARAM: value}} }.
 * Sheets used: Parameter_Dictionary (defaults), Common_Parameters, TOM_Data (per TOM, highest priority).
 */
async function loadTestData(inputDir) {
    const file = await findTestDataWorkbook(inputDir);
    if (!file) return null;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const common = {};
    const perTom = {};
    const put = (target, param, raw) => {
        const key = cellText(param).trim();
        if (!key) return;
        const val = resolveDataValue(raw);
        if (val === undefined || val === '' || /^<.*>$/.test(val)) return;
        target[key] = val;
    };
    for (const r of sheetRows(wb.getWorksheet('Parameter_Dictionary'))) put(common, r.PARAMETER, r.VALUE);
    for (const r of sheetRows(wb.getWorksheet('Common_Parameters'))) put(common, r.PARAMETER, r.VALUE);
    for (const r of sheetRows(wb.getWorksheet('TOM_Data'))) {
        const tom = cellText(r.TOM_NUM).trim().toUpperCase();
        if (!tom) continue;
        perTom[tom] = perTom[tom] || {};
        put(perTom[tom], r.PARAMETER, r.VALUE);
    }
    return { file, common, perTom };
}

function applyTestData(testcases, data) {
    if (!data) return testcases;
    return testcases.map((tc) => {
        const values = { ...data.common, ...(data.perTom[String(tc.TOM_NUM).toUpperCase()] || {}) };
        for (const k of Object.keys(values)) if (SECRET_TOKENS.test(k)) delete values[k];
        const sub = (text) => String(text || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key) => (
            Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m
        ));
        const unresolved = [...new Set(`${tc.Order_Steps}\n${tc.Post_Verification}`.match(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g) || [])]
            .map((t) => t.replace(/[{}\s]/g, ''))
            .filter((k) => !SECRET_TOKENS.test(k) && !Object.prototype.hasOwnProperty.call(values, k));
        if (unresolved.length) {
            process.stderr.write(`[input-agent] ${tc.TOM_NUM}: unresolved data tokens ${unresolved.join(', ')}\n`);
        }
        return { ...tc, Order_Steps: sub(tc.Order_Steps), Post_Verification: sub(tc.Post_Verification) };
    });
}

const REQUIRED_COLUMNS = [
    'TOM_NUM',
    'User_Journey',
    'Order_Steps',
    'Post_Verification'
];

function parseCsv(csvText) {
    const rows = [];
    let currentField = '';
    let currentRow = [];
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i += 1) {
        const char = csvText[i];
        const nextChar = csvText[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentField += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            currentRow.push(currentField);
            currentField = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && nextChar === '\n') {
                i += 1;
            }

            currentRow.push(currentField);
            currentField = '';

            if (currentRow.some((field) => field.trim() !== '')) {
                rows.push(currentRow);
            }

            currentRow = [];
            continue;
        }

        currentField += char;
    }

    if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField);
        if (currentRow.some((field) => field.trim() !== '')) {
            rows.push(currentRow);
        }
    }

    return rows;
}

function buildTestcaseJson(parsedRows) {
    if (!parsedRows.length) {
        return [];
    }

    const headers = parsedRows[0].map((header) => header.trim());
    const missingColumns = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));

    if (missingColumns.length > 0) {
        throw new Error(
            `Missing required column(s): ${missingColumns.join(', ')}. Available columns: ${headers.join(', ')}`
        );
    }

    const headerIndex = Object.fromEntries(headers.map((header, index) => [header, index]));

    return parsedRows
        .slice(1)
        .filter((row) => row.some((cell) => (cell || '').trim() !== ''))
        .map((row) => ({
            TOM_NUM: (row[headerIndex.TOM_NUM] || '').trim(),
            User_Journey: (row[headerIndex.User_Journey] || '').trim(),
            Order_Steps: (row[headerIndex.Order_Steps] || '').trim(),
            Post_Verification: (row[headerIndex.Post_Verification] || '').trim()
        }));
}

async function readInputTestcases(csvFilePath) {
    const inputDir = path.resolve(__dirname, '..', '..', 'input');

    // Ensure the provided path (if any) resolves to a file located inside input/
    const provided = csvFilePath || process.env.INPUT_CSV;
    if (!provided) {
        throw new Error('Input CSV/Excel filename is required. Provide as argument or set INPUT_CSV env var.');
    }
    const basename = path.basename(provided);
    const resolvedPath = path.resolve(inputDir, basename);

    // Check file exists
    let stat;
    try {
        stat = await fs.stat(resolvedPath);
    } catch (err) {
        throw new Error(`Input file not found in input folder: ${resolvedPath}`);
    }

    const ext = path.extname(resolvedPath).toLowerCase();

    if (ext === '.xlsx' || ext === '.xls') {
        // Read Excel and convert to parsedRows format
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(resolvedPath);
        const sheet = wb.worksheets[0];
        if (!sheet) throw new Error(`No worksheet found in ${resolvedPath}`);

        const parsedRows = [];
        sheet.eachRow((row, rowNumber) => {
            // row.values is 1-based with an initial empty element; map to strings
            const values = row.values ? row.values.slice(1).map((v) => (v === undefined || v === null ? '' : String(v))) : [];
            parsedRows.push(values);
        });

        return applyTestData(buildTestcaseJson(parsedRows), await loadTestData(inputDir));
    }

    // Default: treat as CSV
    const csvContent = await fs.readFile(resolvedPath, 'utf8');
    const parsedRows = parseCsv(csvContent);
    return applyTestData(buildTestcaseJson(parsedRows), await loadTestData(inputDir));
}

/**
 * Return test cases whose `User_Journey` matches the provided journeyName.
 * Matching is case-insensitive and uses substring containment so future journeys
 * or slight naming variations are supported without changing agent code.
 *
 * @param {string} journeyName - e.g. 'Mobile PLP'
 * @param {string} [inputFilePath] - optional CSV path; defaults to configured input
 * @returns {Promise<Array>} array of testcase objects
 */
async function getTestCasesByJourney(journeyName, inputFilePath) {
    if (!journeyName || typeof journeyName !== 'string') {
        throw new Error('journeyName (string) is required');
    }
    const all = await readInputTestcases(inputFilePath);
    const needle = journeyName.trim().toLowerCase();
    return all.filter((tc) => (String(tc.User_Journey || '').toLowerCase().includes(needle)));
}

module.exports = {
    readInputTestcases,
    parseCsv,
    buildTestcaseJson,
    getTestCasesByJourney,
    loadTestData,
    applyTestData
};

if (require.main === module) {
    const inputArg = process.argv[2];
    const outputArg = process.argv[3] || process.env.OUTPUT_JSON;
    (async () => {
        try {
            const testcases = await readInputTestcases(inputArg);
            const outStr = `${JSON.stringify(testcases, null, 2)}\n`;
            if (outputArg) {
                const fs = require('fs');
                const path = require('path');
                const outPath = path.resolve(process.cwd(), outputArg);
                const dir = path.dirname(outPath);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(outPath, outStr, 'utf8');
                console.log('Wrote parsed testcases to:', outPath);
            } else {
                process.stdout.write(outStr);
            }
        } catch (error) {
            process.stderr.write(`Input Reader Agent failed: ${error.message}\n`);
            process.exitCode = 1;
        }
    })();
}
