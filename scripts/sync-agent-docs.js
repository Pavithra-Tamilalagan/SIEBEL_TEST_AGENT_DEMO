const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.resolve(__dirname, '..', '.github', 'skills');
const AGENTS_DIR = path.resolve(__dirname, '..', '.github', 'agents');

function readTopComment(content) {
  const m = content.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) return m[1].trim().split(/^\s*\* ?/m).join('\n');
  // fallback to leading // comments
  const lines = content.split(/\r?\n/);
  const leading = [];
  for (const l of lines) {
    if (/^\s*\/\//.test(l)) leading.push(l.replace(/^\s*\/\/?\s?/, ''));
    else if (/^\s*$/.test(l)) continue;
    else break;
  }
  return leading.length ? leading.join('\n') : null;
}

function generateMdForFile(skillPath) {
  const name = path.basename(skillPath);
  const base = name.replace(/\.js$/i, '');
  const target = path.resolve(AGENTS_DIR, `${base}.md`);
  const content = fs.readFileSync(skillPath, 'utf8');
  const top = readTopComment(content);
  const stats = fs.statSync(skillPath);
  const mtime = stats.mtime.toISOString();

  // try to extract a Usage: line present in many CLIs
  const usageMatch = content.match(/Usage:\s*([^\n\r]+)/i) || content.match(/console\.error\('\s*Usage:([^']+)'/i);
  const usage = usageMatch ? usageMatch[1].trim() : `node ${path.relative(process.cwd(), skillPath)} [args]`;

  const md = [];
  md.push(`# ${base} (Agent)
`);
  if (top) md.push(top + '\n');
  md.push('**Location:** ' + path.relative(process.cwd(), skillPath) + '\n');
  md.push(`**Last updated:** ${mtime}\n`);
  md.push('**CLI usage example:**\n');
  md.push('```powershell');
  md.push(usage);
  md.push('```\n');

  md.push('**Description:**\n');
  md.push(`This markdown is auto-generated from the runtime skill at 
${path.relative(process.cwd(), skillPath)}. If the JS changes, run the sync script to update this document.\n`);

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(target, md.join('\n'), 'utf8');
  console.log('Wrote', path.relative(process.cwd(), target));
}

function main() {
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.js'));
  if (!files.length) {
    console.error('No skill JS files found in', SKILLS_DIR);
    process.exit(1);
  }
  for (const f of files) {
    try {
      generateMdForFile(path.resolve(SKILLS_DIR, f));
    } catch (e) {
      console.error('Failed to generate for', f, e && e.message);
    }
  }
}

if (require.main === module) main();
