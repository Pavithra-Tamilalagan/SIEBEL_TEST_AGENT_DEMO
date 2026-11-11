const X = require('exceljs');
const fs = require('fs');
(async () => {
  const f = 'input/TOM_Data_globalized.xlsx';
  fs.mkdirSync('backup', { recursive: true });
  fs.copyFileSync(f, `backup/TOM_Data_globalized.${Date.now()}.xlsx`);
  const w = new X.Workbook();
  await w.xlsx.readFile(f);
  const log = [];
  w.eachSheet((s) => s.eachRow((r, i) => r.eachCell((c, col) => {
    if (typeof c.value === 'string' && /Pro Max Pro Max/.test(c.value)) {
      c.value = c.value.replace(/(Pro Max)( Pro Max)+/g, '$1');
      log.push(`${s.name}!${i}:${col} Pro Max fixed`);
    }
  })));
  const td = w.getWorksheet('TOM_Data');
  td.eachRow((r, i) => {
    if (String(r.getCell(2).value).trim() === 'BRAND_FILTER_2' && /galaxy/i.test(String(r.getCell(3).value))) {
      r.getCell(3).value = 'Samsung';
      log.push(`TOM_Data!${i} ${r.getCell(1).value} BRAND_FILTER_2 -> Samsung`);
    }
  });
  await w.xlsx.writeFile(f);
  fs.writeFileSync('output/_fix_data.txt', log.join('\n') || 'nothing changed');
})().catch((e) => fs.writeFileSync('output/_fix_data.txt', `ERROR ${e.message}`));
