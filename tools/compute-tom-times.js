const fs = require('fs');
const path = require('path');
const p = path.resolve(process.cwd(), 'output', 'TOM.json');
if (!fs.existsSync(p)) {
  console.error('File not found:', p);
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
const times = data.map(x => {
  const s = String(x.executionTime||'0');
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
});
const count = times.length;
const totalMs = times.reduce((a,b)=>a+b,0);
const avgMs = count? Math.round(totalMs/count):0;
const minMs = Math.min(...times);
const maxMs = Math.max(...times);
function fmtMs(ms){
  const s = Math.round(ms/1000);
  const hh = Math.floor(s/3600); const mm = Math.floor((s%3600)/60); const ss = s%60;
  return `${hh.toString().padStart(2,'0')}:${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`;
}
console.log('COUNT:', count);
console.log('TOTAL_MS:', totalMs);
console.log('TOTAL_HHMMSS:', fmtMs(totalMs));
console.log('AVG_MS:', avgMs);
console.log('AVG_HHMMSS:', fmtMs(avgMs));
console.log('MIN_MS:', minMs, 'MIN_HHMMSS:', fmtMs(minMs));
console.log('MAX_MS:', maxMs, 'MAX_HHMMSS:', fmtMs(maxMs));
console.log('\n--- HUMAN SUMMARY ---');
console.log(`All ${count} TOMs total ≈ ${fmtMs(totalMs)} (H:MM:SS)`);
console.log(`Average per TOM ≈ ${fmtMs(avgMs)} (H:MM:SS)`);
console.log(`Range per TOM: min ${fmtMs(minMs)} — max ${fmtMs(maxMs)}`);
