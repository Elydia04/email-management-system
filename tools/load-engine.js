/**
 * tools/load-engine.js — load the Apps Script sources under Node.
 *
 * All .gs files are concatenated in filename order and evaluated together,
 * exactly as Apps Script does. A small shim provides the handful of Apps Script
 * globals the pure logic needs (Logger, Utilities, Session). No Google service
 * is called, so this runs entirely offline.
 *
 * Shared by tools/local-tests.js and tools/extract.js.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXPORTS = [
  'runTests', 'probeFixtures', 'probeText', 'reportExtraction_',
  'extractRecord_', 'extractGeneric_', 'route_', 'buildSource_', 'fixtures_',
  'statusFor_', 'parseAmount_', 'parseDate_', 'stripHtml_', 'normalizeText_',
  'fromDomain_', 'sanitizeCell_', 'buildKeys_', 'firstSeenKey_'
];

function buildSource() {
  const root = path.resolve(__dirname, '..');
  const files = fs.readdirSync(root)
    .filter(function (f) { return /^\d{2}_.*\.gs$/.test(f); })
    .sort();
  if (fs.existsSync(path.join(root, 'Fixtures.gs'))) files.push('Fixtures.gs');

  const shim = [
    'var Buffer = require("buffer").Buffer;',
    'var crypto = require("crypto");',
    'var Logger = { log: function (m) { if (process.env.VERBOSE) console.log(String(m)); } };',
    'var Utilities = {',
    '  DigestAlgorithm: { MD5: "MD5" },',
    '  newBlob: function (a) { return { getBytes: function () { return Array.from(Buffer.from(String(a), "utf8")); } }; },',
    '  computeDigest: function (alg, bytes) { return Array.from(crypto.createHash("md5").update(Buffer.from(bytes)).digest()); },',
    '  sleep: function () {},',
    '  formatDate: function (d) { return d.toISOString(); }',
    '};',
    'var Session = { getScriptTimeZone: function () { return "America/Chicago"; } };',
    'var __props = {};',
    'var PropertiesService = { getScriptProperties: function () { return {',
    '  getProperty: function (k) { return Object.prototype.hasOwnProperty.call(__props, k) ? __props[k] : null; },',
    '  setProperty: function (k, v) { __props[k] = String(v); },',
    '  deleteProperty: function (k) { delete __props[k]; }',
    '}; } };'
  ].join('\n');

  let src = shim + '\n';
  files.forEach(function (f) {
    src += '\n// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(root, f), 'utf8') + '\n';
  });
  src += '\nmodule.exports = {\n' +
    EXPORTS.map(function (n) { return '  ' + n + ': ' + n; }).join(',\n') +
    '\n};\n';
  return src;
}

let cached = null;

/** Evaluate (once) and return the engine's exported functions. */
function load() {
  if (cached) return cached;
  const tmp = path.join(os.tmpdir(), 'invoice_engine_' + Date.now() + '_' +
    Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(tmp, buildSource(), 'utf8');
  try {
    cached = require(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
  return cached;
}

module.exports = { load: load };
