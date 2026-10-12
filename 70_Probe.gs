/**
 * 70_Probe.gs — read-only inspection mode.
 *
 * PROBE never writes to the ledger. Use it to understand what the engine sees
 * for fixtures today and for real samples later:
 *
 *   probeFixtures()                 - run the synthetic fixtures
 *   probeLabel(20)                  - run the real messages under the label
 *   probeText('subj', 'a@b.com', t) - run ad-hoc pasted text
 *   probeDriveFile('<fileId>')      - run a PDF/image through the OCR path
 *
 * Output goes to the execution log (View > Logs) and is also returned.
 */

function reportExtraction_(name, source, multiColumnRisk) {
  const routed = route_(source.from, source.bodyText);
  const kind = source._kind || 'body';
  const f = extractRecord_({
    text: source.bodyText || '',
    sourceKind: kind,
    vendor: routed.vendor,
    template: routed.template,
    jsonLd: source.jsonLd || null,
    multiColumnRisk: !!multiColumnRisk
  });
  const status = statusFor_(f, (source.bodyText || '').trim().length);

  const lines = [];
  lines.push('--- ' + name + ' ---');
  lines.push('from=' + source.from + '  domain=' + routed.domain +
    (routed.platform ? ' [platform]' : '') + '  vendor=' + routed.vendor +
    '  template=' + routed.template.name);
  lines.push('docType=' + f.docType + '  status=' + status + '  confidence=' + f.confidence);
  lines.push('invoiceNo="' + f.invoiceNo + '"  invoiceDate=' + f.invoiceDate +
    '  dueDate=' + f.dueDate + (f.dateAmbiguous ? ' (date ambiguous)' : ''));
  lines.push('amount=' + f.amount + ' ' + f.currency +
    (f.amountAmbiguous ? ' (amount ambiguous)' : '') + '  tax=' + f.tax);
  if (f.isPortal) lines.push('PORTAL detected (no amount in body)');
  if (f.evidence && f.evidence.length) {
    lines.push('evidence=' + f.evidence.map(function (e) { return e.field + ':' + e.anchor; }).join(', '));
  }
  lines.forEach(function (l) { Logger.log(l); });
  return { lines: lines, fields: f, routed: routed, status: status };
}

function probeFixtures() {
  const out = [];
  fixtures_().forEach(function (item) {
    const source = {
      messageId: 'fixture:' + item.name, from: item.from, subject: item.subject,
      bodyText: item.text, html: '', jsonLd: item.jsonLd || null, attachments: []
    };
    const r = reportExtraction_(item.name + ' [' + item.kind + ']', source, item.kind === 'ocr');
    out.push(r.lines.join('\n'));
  });
  const all = out.join('\n\n');
  Logger.log(all);
  return all;
}

/** Inspect the real messages currently under the invoice label (no writes). */
function probeLabel(limit) {
  const labelName = invoiceLabelName_();
  const threads = GmailApp.search('label:"' + labelName + '"', 0, limit || 10);
  let n = 0;
  threads.forEach(function (th) {
    th.getMessages().forEach(function (m) {
      reportExtraction_('msg:' + m.getId(), buildSource_(m));
      n++;
    });
  });
  const msg = 'probed ' + n + ' message(s); no ledger writes';
  Logger.log(msg);
  return msg;
}

/** Inspect ad-hoc pasted text. */
function probeText(subject, from, text) {
  const source = {
    messageId: 'probe:text', from: from || '', subject: subject || '',
    bodyText: text || '', html: '', jsonLd: null, attachments: []
  };
  return reportExtraction_('probe-text', source).lines.join('\n');
}

/**
 * Inspect a Drive-hosted PDF/image through the real OCR path (no writes).
 * Dev helper: with the drive.file scope this can only read files the script
 * itself created. Reading an arbitrary Drive file would need the full `drive`
 * scope, which this project deliberately does not request.
 */
function probeDriveFile(fileId) {
  const file = DriveApp.getFileById(fileId);
  const att = { name: file.getName(), mimeType: file.getMimeType(), bytes: file.getBlob().getBytes() };
  const r = ocrBlobText_(att);
  Logger.log('OCR: error=' + (r.error || 'none') + ' tables=' + (r.tables ? r.tables.length : 0));
  const source = {
    messageId: 'probe:drive', from: '', subject: file.getName(),
    bodyText: r.text, html: '', jsonLd: null, attachments: []
  };
  return reportExtraction_('drive:' + file.getName(), source, r.tables && r.tables.length > 1);
}
