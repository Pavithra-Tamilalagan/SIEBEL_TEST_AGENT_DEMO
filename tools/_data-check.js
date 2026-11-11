const L = require('../.github/skills/test-data-loader');
const fs = require('fs');
(async () => {
  const out = [];
  for (const id of (process.argv[2] || 'TOM_05,TOM_11,TOM_15').split(',')) {
    const { data } = await L.loadTestDataForTom(id);
    const o = {};
    for (const k of Object.keys(data)) if (!/USERNAME|PASSWORD|SIEBEL_|ENV_URL|BASE_URL/.test(k)) o[k] = data[k];
    out.push(id + ' ' + JSON.stringify(o));
  }
  fs.writeFileSync('output/_data_check.txt', out.join('\n'));
})();
