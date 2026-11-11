// Remove one TOM id from CSV + data workbook and shift later ids down by 1.
const fs = require('fs');
const X = require('exceljs');
const DROP = Number(process.argv[2] || 17);
const csvPath = 'input/generated_mobile_plp_test_cases_from_ssj_md.csv';
const xlsPath = 'input/TOM_Data_globalized.xlsx';
const pad = (n) => `TOM_${String(n).padStart(2, '0')}`;
const shift = (s) => s.replace(/\bTOM_(\d+)\b/g, (a, d) => (Number(d) > DROP ? pad(Number(d) - 1) : a));
const log = [];
(async () => {
  fs.mkdirSync('backup', { recursive: true });
  const ts = Date.now();
  fs.copyFileSync(csvPath, `backup/generated_mobile_plp_test_cases_from_ssj_md.${ts}.csv`);
  fs.copyFileSync(xlsPath, `backup/TOM_Data_globalized.${ts}.xlsx`);

  // CSV: records start at lines beginning with "TOM_NN",
  const text = fs.readFileSync(csvPath, 'utf8');
  const parts = text.split(/\r?\n(?="TOM_\d+",)/);
  const kept = parts.filter((p) => !p.startsWith(`"${pad(DROP)}",`));
  log.push(`CSV records ${parts.length} -> ${kept.length}`);
  fs.writeFileSync(csvPath, kept.map((p) => p.replace(/^"TOM_(\d+)",/, (a, d) => `"${Number(d) > DROP ? pad(Number(d) - 1) : pad(Number(d))}",`)).join('\n'));

  // Workbook: delete rows whose id cell == DROP, shift others
  const w = new X.Workbook();
  await w.xlsx.readFile(xlsPath);
  w.eachSheet((s) => {
    const del = [];
    s.eachRow((r, i) => {
      let isDrop = false;
      r.eachCell((c) => {
        if (typeof c.value !== 'string') return;
        if (c.value.trim() === pad(DROP)) isDrop = true;
        else if (/\bTOM_\d+\b/.test(c.value)) { const n = shift(c.value); if (n !== c.value) { c.value = n; } }
      });
      if (isDrop) del.push(i);
    });
    del.reverse().forEach((i) => s.spliceRows(i, 1));
    if (del.length) log.push(`${s.name}: removed ${del.length} row(s) for ${pad(DROP)}`);
  });
  await w.xlsx.writeFile(xlsPath);
  fs.writeFileSync('output/_renumber.txt', log.join('\n'));
})().catch((e) => fs.writeFileSync('output/_renumber.txt', 'ERROR ' + e.stack));
