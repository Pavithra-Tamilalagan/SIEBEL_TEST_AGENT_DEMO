const assert = require('assert');
const child = require('child_process');
const path = require('path');

function runCliForTom(tomId) {
  const cli = process.execPath; // node
  const scriptPath = path.resolve(__dirname, '..', '.github', 'skills', 'playwright-generator.js');
  const tomPath = path.resolve(__dirname, '..', 'output', 'TOM.json');
  const cmd = `${JSON.stringify(cli)} ${JSON.stringify(scriptPath)} ${JSON.stringify(tomPath)} --tom ${JSON.stringify(tomId)}`;
  try {
    const out = child.execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return out;
  } catch (e) {
    throw new Error(`CLI failed for ${tomId}: ${e.message}\n${e.stdout || ''}${e.stderr || ''}`);
  }
}

function testTomCli(id, expectContains) {
  const out = runCliForTom(id);
  for (const substr of expectContains) {
    assert(out.includes(substr), `Expected CLI output for ${id} to include: ${substr}`);
  }
  console.log(`TOM ${id} OK`);
}

// Unit tests based on TOM_01 and TOM_67 using the CLI entrypoint
try {
  testTomCli('TOM_01', ['launchMobilePLP', 'AUTO_ASSERTION', 'Select']);
  testTomCli('TOM_67', ['Add to cart', 'Create quote', 'Create order'].map(s => s.split(' ').slice(0,2).join(' ')));
  console.log('All tests passed');
} catch (e) {
  console.error('Test failed:', e && e.message);
  process.exit(1);
}
