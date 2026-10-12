/**
 * tools/extract.js — run the extraction engine on arbitrary text, offline.
 *
 * Usage:
 *   node tools/extract.js "Invoice Number: INV-7\nTotal: $250.00"
 *   node tools/extract.js --from "billing@acme.com" --file sample.txt
 *   cat sample.txt | node tools/extract.js --from "billing@acme.com" -
 *
 * Prints the same report as the in-editor probeText(). No writes, ever.
 */
const fs = require('fs');
const engine = require('./load-engine').load();

function parseArgs(argv) {
  const opts = { from: '', subject: '', file: null, inline: null, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i] || '';
    else if (a === '--subject') opts.subject = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '-') opts.stdin = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (opts.inline === null) opts.inline = a;
    else opts.inline += ' ' + a;
  }
  return opts;
}

function usage() {
  console.log([
    'Usage:',
    '  node tools/extract.js "TEXT..."',
    '  node tools/extract.js --file <path> [--from <sender>] [--subject ".."]',
    '  cat sample.txt | node tools/extract.js --from "billing@acme.com" -',
    '',
    'Notes:',
    '  - Runs the real extraction engine; nothing is written to any sheet.',
    '  - Use --file to point at a saved email body or OCR text.',
    '  - PDF/image OCR is not available offline; pass the already-extracted text.'
  ].join('\n'));
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let text = null;
  if (opts.file) text = fs.readFileSync(opts.file, 'utf8');
  else if (opts.stdin) text = readStdin();
  else if (opts.inline !== null) text = opts.inline;

  if (text === null || text === '') {
    usage();
    process.exitCode = 1;
    return;
  }

  const source = {
    messageId: 'local', from: opts.from || '', subject: opts.subject || '',
    bodyText: text, html: '', jsonLd: null, attachments: []
  };
  const r = require('./load-engine').load().reportExtraction_(
    'local:' + (opts.file || 'inline'), source);
  console.log(r.lines.join('\n'));
}

main();
