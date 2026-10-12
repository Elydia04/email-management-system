/**
 * tools/build-bundle.js — produce a single pasteable Apps Script file.
 *
 *   node tools/build-bundle.js
 *
 * Writes dist/InvoiceTracker.gs (all sources concatenated in load order) and
 * dist/appsscript.json (the manifest). Used for the no-tools browser setup:
 * create a project, paste the manifest, paste the bundle, done.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const files = fs.readdirSync(root)
  .filter(function (f) { return /^\d{2}_.*\.gs$/.test(f); })
  .sort();
if (fs.existsSync(path.join(root, 'Fixtures.gs'))) files.push('Fixtures.gs');

const bar = '// ============================================================';
let out = '';
out += '/**\n';
out += ' * InvoiceTracker.gs — GENERATED single-file bundle. Do not edit by hand.\n';
out += ' * Regenerate with: node tools/build-bundle.js\n';
out += ' * Sources: ' + files.join(', ') + '\n';
out += ' */\n\n';
files.forEach(function (f) {
  out += bar + '\n// ' + f + '\n' + bar + '\n\n' +
    fs.readFileSync(path.join(root, f), 'utf8') + '\n\n';
});

fs.writeFileSync(path.join(dist, 'InvoiceTracker.gs'), out, 'utf8');
fs.copyFileSync(path.join(root, 'appsscript.json'), path.join(dist, 'appsscript.json'));

console.log('wrote dist/InvoiceTracker.gs (' + out.split('\n').length + ' lines, ' +
  files.length + ' files) and dist/appsscript.json');
