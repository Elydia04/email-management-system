/**
 * tools/local-tests.js — run the pure extraction logic under Node.
 *
 * Apps Script globals are shimmed with the minimum needed to exercise the
 * testable functions. This is how the engine is verified without deploying.
 *
 *   node tools/local-tests.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(root)
  .filter(function (f) { return /^\d{2}_.*\.gs$/.test(f); })
  .sort();
if (fs.existsSync(path.join(root, 'Fixtures.gs'))) files.push('Fixtures.gs');

const shim = [
  'var __OUT = [];',
  'var Logger = { log: function (m) { __OUT.push(String(m)); } };',
  'var Buffer = require("buffer").Buffer;',
  'var crypto = require("crypto");',
  'var Utilities = {',
  '  DigestAlgorithm: { MD5: "MD5" },',
  '  newBlob: function (a) { return { getBytes: function () { return Array.from(Buffer.from(String(a), "utf8")); } }; },',
  '  computeDigest: function (alg, bytes) { return Array.from(crypto.createHash("md5").update(Buffer.from(bytes)).digest()); },',
  '  sleep: function () {}',
  '};'
].join('\n');

let src = shim + '\n';
files.forEach(function (f) {
  src += '\n// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(root, f), 'utf8') + '\n';
});
src += [
  '',
  'var __res = runTests();',
  '__OUT.forEach(function (l) { console.log(l); });',
  'var __fixtures = probeFixtures();',
  'module.exports = { res: __res, out: __OUT, fixtures: __fixtures };'
].join('\n');

const tmp = path.join(os.tmpdir(), 'invoice_tracker_combined_' + Date.now() + '.js');
fs.writeFileSync(tmp, src, 'utf8');

try {
  const mod = require(tmp);
  console.log('\n===== FIXTURE PROBE (read-only) =====\n' + mod.fixtures);
  const passed = mod.res.total - mod.res.failed;
  console.log('\nSUMMARY: ' + passed + '/' + mod.res.total + ' passed');
  process.exitCode = mod.res.failed ? 1 : 0;
} catch (e) {
  console.error('HARNESS ERROR:', e && e.stack ? e.stack : e);
  process.exitCode = 2;
} finally {
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
}
