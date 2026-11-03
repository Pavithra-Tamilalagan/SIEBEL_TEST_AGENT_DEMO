const ExcelJS = require('exceljs');
const fs = require('fs');
(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('input/TOM_Data_globalized.xlsx');
  const out = [];
  for (const ws of wb.worksheets) {
    out.push(`SHEET ${ws.name} rows=${ws.rowCount} cols=${ws.columnCount}`);
    for (let r = 1; r <= Math.min(ws.rowCount, 8); r++) {
      out.push(JSON.stringify(ws.getRow(r).values.slice(1).map(v => (v && v.text) ? v.text : v)));
    }
  }
  fs.writeFileSync('output/_data_dump.txt', out.join('\n'));
})();
