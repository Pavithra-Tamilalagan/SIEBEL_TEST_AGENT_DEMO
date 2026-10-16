#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const result = {
    tom: '',
    input: process.env.INPUT_CSV || '',
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--input' || arg === '-i') {
      if (argv[i + 1]) result.input = argv[++i];
      continue;
    }

    if (arg === '--dry-run' || arg === '-n') {
      result.dryRun = true;
      continue;
    }

    if (arg === '--tom' || arg === '-t') {
      if (argv[i + 1]) result.tom = argv[++i];
      continue;
    }

    if (!arg.startsWith('-')) {
      if (!result.tom) result.tom = arg;
      else if (!result.input) result.input = arg;
    }
  }

  return result;
}

function normalizeTomId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/(?:TOM[_-]?)?(\d+)/i);
  if (!match) return raw.toUpperCase();
  return `TOM_${String(Number.parseInt(match[1], 10)).padStart(2, '0')}`;
}

function parseTomSelection(selector = '') {
  const raw = String(selector || '').trim();
  if (!raw || /^(all|--all)$/i.test(raw)) return [];

  const entries = raw.split(/[;,\s]+/).map((entry) => String(entry || '').trim()).filter(Boolean);
  const selected = new Set();

  for (const entry of entries) {
    if (entry.includes('-')) {
      const parts = entry.split('-').map((part) => String(part || '').trim()).filter(Boolean);
      if (parts.length === 2) {
        const start = Number.parseInt((parts[0].match(/\d+/) || [])[0], 10) || 0;
        const end = Number.parseInt((parts[1].match(/\d+/) || [])[0], 10) || 0;
        const begin = Math.min(start, end);
        const finish = Math.max(start, end);
        for (let num = begin; num <= finish; num += 1) {
          selected.add(`TOM_${String(num).padStart(2, '0')}`);
        }
        continue;
      }
    }

    selected.add(normalizeTomId(entry));
  }

  return Array.from(selected).sort((a, b) => {
    const aNum = Number.parseInt(String(a).match(/\d+/)?.[0] || '0', 10);
    const bNum = Number.parseInt(String(b).match(/\d+/)?.[0] || '0', 10);
    return aNum - bNum;
  });
}

function parseLastJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const idx = text.lastIndexOf('{');
    if (idx >= 0) {
      try {
        return JSON.parse(text.slice(idx));
      } catch (e2) {
        return null;
      }
    }
  }
  return null;
}

function printUsage() {
  console.log('Usage: node scripts/run-tom-batch.js [TOM_SELECTOR] [--input <csv-or-xlsx>] [--dry-run]');
  console.log('Examples:');
  console.log('  node scripts/run-tom-batch.js TOM_02-TOM_10');
  console.log('  node scripts/run-tom-batch.js TOM_02,TOM_05,TOM_09');
  console.log('  node scripts/run-tom-batch.js --input input/Journey1_mobile_plp_test_cases_from_ssj.csv --dry-run TOM_02-TOM_10');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.input) {
    args.input = path.resolve(__dirname, '..', 'input', 'Journey1_mobile_plp_test_cases_from_ssj.csv');
  }

  const selectedList = parseTomSelection(args.tom || 'all');
  const resolvedInput = path.resolve(args.input);

  if (args.dryRun) {
    const fileHint = fs.existsSync(resolvedInput) ? resolvedInput : '<missing-file>';
    console.log('Dry-run batch selection');
    console.log('Input file:', fileHint);
    console.log('Selector:', args.tom || 'all');
    console.log('Resolved TOMs:', selectedList.length ? selectedList.join(', ') : 'ALL');
    return;
  }

  const orchestrator = path.resolve(__dirname, '..', '.github', 'skills', 'orchestrator-agent.js');
  const node = process.execPath;
  const spawnArgs = [];
  if (args.tom) spawnArgs.push(args.tom);
  spawnArgs.push(resolvedInput);

  const env = { ...process.env, INPUT_CSV: resolvedInput };
  const proc = spawnSync(node, [orchestrator, ...spawnArgs], { encoding: 'utf8', env });

  const stdout = String(proc.stdout || '');
  const stderr = String(proc.stderr || '');

  if (stdout) {
    const parsed = parseLastJson(stdout);
    if (parsed) {
      const summaryPath = path.resolve(__dirname, '..', 'output', `batch-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(summaryPath, JSON.stringify(parsed, null, 2), 'utf8');
      console.log('Batch run summary saved to:', summaryPath);
      console.log(JSON.stringify({
        total: parsed.total || 0,
        passed: parsed.passed || 0,
        failed: parsed.failed || 0,
        executionTime: parsed.executionTime || 'n/a',
      }, null, 2));
    }
  }

  if (proc.status !== 0) {
    console.error(stderr || 'Batch run failed');
    process.exit(proc.status || 1);
  }

  if (stdout) console.log(stdout.trim());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}
