const fs = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');

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

        return buildTestcaseJson(parsedRows);
    }

    // Default: treat as CSV
    const csvContent = await fs.readFile(resolvedPath, 'utf8');
    const parsedRows = parseCsv(csvContent);
    return buildTestcaseJson(parsedRows);
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
    getTestCasesByJourney
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
