#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const out = { tom: '', input: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) { out.input = argv[++i]; }
    else if (a === '--tom' && argv[i + 1]) { out.tom = argv[++i]; }
    else if (!a.startsWith('-')) {
      if (!out.tom) out.tom = a;
      else if (!out.input) out.input = a;
    }
  }
  // fallback to env var
  if (!out.input) out.input = process.env.INPUT_CSV || '';
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orchestrator = path.resolve(__dirname, 'orchestrator-agent.js');
  const node = process.execPath;

  const spawnOptions = { encoding: 'utf8', env: { ...process.env } };
  if (args.input) spawnOptions.env.INPUT_CSV = args.input;

  const spawnArgs = [];
  if (args.tom) spawnArgs.push(args.tom);
  // if no TOM provided, rely on INPUT_CSV env var and call orchestrator without positional args

  const proc = spawnSync(node, [orchestrator, ...spawnArgs], spawnOptions);
  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';
  if (proc.status !== 0) {
    console.error('Orchestrator failed:', stderr.toString());
    process.exit(proc.status || 1);
  }

  // try to extract JSON output from stdout (orchestrator prints JSON at end)
  const outStr = stdout.toString();
  let json = null;
  try { json = JSON.parse(outStr); } catch (e) {
    const idx = outStr.lastIndexOf('{');
    if (idx >= 0) {
      try { json = JSON.parse(outStr.slice(idx)); } catch (e2) { /* ignore */ }
    }
  }

  const summaryDir = path.resolve(process.cwd(), 'summary-artifacts');
  fs.mkdirSync(summaryDir, { recursive: true });
  const now = new Date();
  const mdPath = path.resolve(summaryDir, `execution-summary-${now.toISOString().replace(/[:.]/g,'-')}.md`);

  const lines = [];
  lines.push('# Execution Summary');
  lines.push('');
  if (!json) {
    lines.push('**No JSON output parsed from orchestrator.**');
    lines.push('');
    lines.push('Raw stdout:');
    lines.push('```');
    lines.push(outStr);
    lines.push('```');
  } else {
    lines.push(`- **Total:** ${json.total || 0}`);
    lines.push(`- **Passed:** ${json.passed || 0}`);
    lines.push(`- **Failed:** ${json.failed || 0}`);
    lines.push(`- **Execution Time:** ${json.executionTime || 'n/a'}`);
    lines.push('');
    if (Array.isArray(json.agentTimings)) {
      lines.push('## Agent Timings');
      lines.push('');
      for (const t of json.agentTimings) {
        lines.push(`- **${t.agent}** (${t.testcase || 'ALL'}): ${t.durationMs} ms`);
      }
      lines.push('');
    }

    if (Array.isArray(json.results) && json.results.length) {
      lines.push('## Results');
      lines.push('');
      for (const r of json.results) {
        lines.push(`### ${r.testCaseId || r.testcase || r.TOM || 'unknown'}`);
        lines.push(`- **Status:** ${r.status || 'n/a'}`);
        if (r.reason) lines.push(`- **Failure reason:** ${r.reason}`);
        if (r.screenshot) lines.push(`- **Screenshot:** ${r.screenshot}`);
        lines.push('');
      }
    }
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  console.log('Wrote summary:', mdPath);
}

if (require.main === module) main();
