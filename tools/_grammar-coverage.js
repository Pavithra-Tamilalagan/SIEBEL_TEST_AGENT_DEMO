// Dry-run: which business steps in the CSV are recognised by the generic step grammar?
const fs = require('fs');
const { readInputTestcases } = require('../.github/skills/input-agent');
const { matchStep } = require('../.github/skills/step-runner');
const { splitAndCleanSteps } = require('../.github/skills/execution-agent');
const pre = /^open\s+(https?:|\{\{ENV_URL)|user id|password|^click login|site map|sales calculator link|first name|last name|enter new customer details|address lookup|address result|coverage check page|^click next\.?$/i;
(async () => {
  const all = await readInputTestcases(process.argv[2] || 'generated_mobile_plp_test_cases_from_ssj_md.csv');
  const unmapped = {};
  for (const tc of all) {
    const steps = splitAndCleanSteps(tc.Order_Steps);
    let i = 0; while (i < steps.length && pre.test(steps[i])) i += 1;
    for (const s of steps.slice(i)) {
      if (!matchStep(s)) (unmapped[s.replace(/\{\{[^}]+\}\}/g, '<P>')] ||= []).push(tc.TOM_NUM);
    }
  }
  const lines = Object.entries(unmapped).map(([s, t]) => `${s}  <-  ${[...new Set(t)].join(',')}`);
  fs.writeFileSync('output/_grammar_coverage.txt', `UNMAPPED (${lines.length}):\n` + lines.join('\n'));
})();
