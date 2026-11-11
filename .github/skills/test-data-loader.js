/**
 * Generic, data-driven test-data loader.
 *
 * - Locates the test data workbook in input/ (TEST_DATA_XLSX env, else first *data*.xlsx).
 * - Builds a parameter map for a TOM:  Common_Parameters  <  TOM_Data rows for that TOM.
 * - Values of form ".env:KEY" are read from process.env (with aliases from config/env-aliases.json).
 * - Placeholder values like "<CONFIRM_IN_UI>" are treated as missing.
 * - resolvePlaceholders() replaces every {{PARAM}} in a string with its value.
 *
 * No journey / TOM / business values are hard-coded here.
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.resolve(__dirname, '..', '..');
const INPUT_DIR = path.join(ROOT, 'input');
const ALIAS_FILE = path.join(ROOT, 'config', 'env-aliases.json');
const TOKEN_RX = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

function loadAliases() {
    try {
        const json = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8'));
        delete json._comment;
        return json;
    } catch (e) {
        return {};
    }
}

function findDataWorkbook() {
    if (process.env.TEST_DATA_XLSX) {
        const p = path.resolve(INPUT_DIR, path.basename(process.env.TEST_DATA_XLSX));
        if (fs.existsSync(p)) return p;
    }
    if (!fs.existsSync(INPUT_DIR)) return null;
    const hit = fs.readdirSync(INPUT_DIR)
        .find((f) => /data/i.test(f) && /\.xlsx$/i.test(f) && !/_results\.xlsx$/i.test(f) && !/backup|copy|\bold\b/i.test(f) && !f.startsWith('~$'));
    return hit ? path.join(INPUT_DIR, hit) : null;
}

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        if (v.text) return String(v.text);
        if (v.result !== undefined) return String(v.result);
        if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    }
    return String(v);
}

function readEnv(key, aliases) {
    const direct = (process.env[key] || '').trim();
    if (direct) return direct;
    for (const alt of aliases[key] || []) {
        const v = (process.env[alt] || '').trim();
        if (v) return v;
    }
    return '';
}

function resolveValue(raw, paramName, aliases) {
    const value = cellText(raw).trim();
    if (!value || /^<.*>$/.test(value)) return '';
    const envRef = value.match(/^\.env:([A-Za-z0-9_]+)$/i);
    if (envRef) return readEnv(envRef[1], aliases) || readEnv(paramName, aliases);
    return value;
}

function readSheet(ws) {
    const header = ws.getRow(1).values.slice(1).map((h) => cellText(h).trim());
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r++) {
        const vals = ws.getRow(r).values.slice(1);
        const obj = {};
        header.forEach((h, i) => { if (h) obj[h] = vals[i]; });
        rows.push(obj);
    }
    return rows;
}

async function loadTestDataForTom(tomId) {
    const aliases = loadAliases();
    const file = findDataWorkbook();
    const data = {};
    if (file) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(file);
        const common = wb.getWorksheet('Common_Parameters');
        if (common) {
            for (const row of readSheet(common)) {
                const key = cellText(row.PARAMETER).trim();
                const val = resolveValue(row.VALUE, key, aliases);
                if (key && val) data[key] = val;
            }
        }
        const tomSheet = wb.getWorksheet('TOM_Data');
        const id = String(tomId || '').trim().toUpperCase();
        if (tomSheet && id) {
            for (const row of readSheet(tomSheet)) {
                if (cellText(row.TOM_NUM).trim().toUpperCase() !== id) continue;
                const key = cellText(row.PARAMETER).trim();
                const val = resolveValue(row.VALUE, key, aliases);
                if (key && val) data[key] = val;
            }
        }
    }
    // Keep aliased env names in sync with data-sheet values (configured in config/env-aliases.json)
    for (const [key, alts] of Object.entries(aliases)) {
        if (!data[key]) {
            const v = readEnv(key, aliases);
            if (v) data[key] = v;
        }
        if (data[key]) for (const alt of alts) data[alt] = data[key];
    }
    return { file, data };
}

/** Return list of {{TOKENS}} used in text. */
function extractTokens(text) {
    const out = new Set();
    String(text || '').replace(TOKEN_RX, (m, k) => { out.add(k); return m; });
    return [...out];
}

/** Replace {{TOKEN}} with data[TOKEN]. Unknown tokens are left as-is and reported. */
function resolvePlaceholders(text, data) {
    const missing = new Set();
    const resolved = String(text || '').replace(TOKEN_RX, (m, k) => {
        if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== '') return data[k];
        missing.add(k);
        return m;
    });
    return { text: resolved, missing: [...missing] };
}

/** Resolve Order_Steps (array or text) + Post_Verification for a test case. */
function resolveTestCase(testCase, data) {
    const missing = new Set();
    const res = (t) => { const r = resolvePlaceholders(t, data); r.missing.forEach((m) => missing.add(m)); return r.text; };
    const out = { ...testCase };
    if (Array.isArray(testCase.steps)) out.steps = testCase.steps.map(res);
    if (typeof testCase.Order_Steps === 'string') out.Order_Steps = res(testCase.Order_Steps);
    if (Array.isArray(testCase.Order_Steps)) out.Order_Steps = testCase.Order_Steps.map(res);
    for (const k of ['Post_Verification', 'PostVerification', 'postVerification']) {
        if (typeof testCase[k] === 'string') out[k] = res(testCase[k]);
    }
    return { testCase: out, missing: [...missing] };
}

async function buildEnvForTom(tomId) {
    const { file, data } = await loadTestDataForTom(tomId);
    return { file, data, env: { ...process.env, ...data } };
}

module.exports = {
    loadTestDataForTom,
    buildEnvForTom,
    findDataWorkbook,
    extractTokens,
    resolvePlaceholders,
    resolveTestCase
};
