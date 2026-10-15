const ExcelJS = require('exceljs');
const path = require('path');
(async () => {
  try {
    const fp = path.resolve(process.argv[2] || './input/Execution_Results.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const ws = wb.worksheets[0];
    const rows = [];
    const header = [];
    ws.getRow(1).eachCell((cell, colNumber) => header[colNumber] = String(cell.value || '').trim());
    for (let r=2;r<=ws.rowCount;r++){
      const row = ws.getRow(r);
      const obj = {};
      for (let c=1;c<=header.length;c++){
        if (!header[c]) continue;
        obj[header[c]] = row.getCell(c).value || '';
      }
      if (Object.keys(obj).length) rows.push(obj);
    }
    console.log(JSON.stringify({ path: fp, rows: Math.min(rows.length, 20), sample: rows.slice(0,20) }, null, 2));
  } catch (e) {
    console.error('Failed to read workbook', e && e.message);
    process.exit(2);
  }
})();
