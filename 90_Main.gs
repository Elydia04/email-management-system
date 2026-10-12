/**
 * 90_Main.gs — pipeline orchestration and entry points.
 */

function safeCall_(fn, dflt) {
  try { const v = fn(); return (v === null || v === undefined) ? dflt : v; } catch (e) { return dflt; }
}

// ---- Gmail -> source object -------------------------------------------------

/**
 * Convert a Gmail message into a plain "source" object.
 * This is the ONLY place that touches Gmail for extraction, and the shape it
 * produces is exactly what 70_Probe.gs and the fixtures use.
 */
function buildSource_(msg) {
  const html = safeCall_(function () { return msg.getBody(); }, '') || '';
  let plain = safeCall_(function () { return msg.getPlainBody(); }, '') || '';
  if (!plain.trim()) plain = stripHtml_(html);
  const blobs = safeCall_(function () { return msg.getAttachments(); }, []) || [];
  const attachments = blobs.map(function (b) {
    return {
      name: safeCall_(function () { return b.getName(); }, '') || '',
      mimeType: safeCall_(function () { return b.getContentType(); }, '') || '',
      bytes: safeCall_(function () { return b.getBytes(); }, []) || [],
      blob: b
    };
  });
  const date = safeCall_(function () { return msg.getDate(); }, null);
  return {
    messageId: safeCall_(function () { return msg.getId(); }, '') || '',
    from: safeCall_(function () { return msg.getFrom(); }, '') || '',
    subject: safeCall_(function () { return msg.getSubject(); }, '') || '',
    dateIso: date ? date.toISOString() : '',
    bodyText: plain,
    html: html,
    jsonLd: html ? parseJsonLd_(html) : null,
    attachments: attachments
  };
}

// ---- attachment handling ----------------------------------------------------

function attachmentKind_(mimeType, name) {
  const m = String(mimeType || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.indexOf('pdf') !== -1 || /\.pdf$/.test(n)) return 'pdf';
  if (m.indexOf('image/') === 0) return 'image';
  if (m.indexOf('text/') === 0 || /\.(txt|csv|tsv)$/.test(n)) return 'text';
  return 'other';
}

/** Obtain text for an attachment (OCR / decode). Returns a descriptor. */
function attachmentText_(att) {
  const kind = attachmentKind_(att.mimeType, att.name);
  if (kind === 'text') {
    let text = '';
    try { text = Utilities.newBlob(att.bytes).getDataAsString(); } catch (e) { text = ''; }
    return { text: text, kind: 'text', multiColumnRisk: false, error: '' };
  }
  if (kind === 'pdf' || kind === 'image') {
    const r = ocrBlobText_(att);
    return {
      text: r.text, kind: 'ocr', multiColumnRisk: (r.tables && r.tables.length > 1),
      error: r.error || '', encrypted: !!r.encrypted
    };
  }
  return { text: '', kind: kind, multiColumnRisk: false, error: 'unsupported type' };
}

function tempOcrFolder_() {
  const id = cfg_(PROP.TEMP_OCR_FOLDER_ID, '');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate */ } }
  const f = DriveApp.createFolder('TempInvoiceOCR');
  setProp_(PROP.TEMP_OCR_FOLDER_ID, f.getId());
  return f;
}

/** Remove OCR temp docs older than an hour. */
function cleanupTempOcr_() {
  try {
    const folder = tempOcrFolder_();
    const it = folder.getFiles();
    const cutoff = Date.now() - 60 * 60 * 1000;
    while (it.hasNext()) {
      const file = it.next();
      if (file.getDateCreated().getTime() < cutoff) {
        try { file.setTrashed(true); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    log_('WARN', 'temp cleanup failed: ' + (e && e.message ? e.message : e));
  }
}

/**
 * Convert a PDF/image to a Google Doc (which triggers Drive OCR), read the text
 * AND any tables, then delete the temp doc. Tables matter: flattening a
 * two-column invoice scrambles label/value adjacency (see RISKS.md C6).
 */
function ocrBlobText_(att) {
  if (!att.bytes || !att.bytes.length) return { text: '', tables: [], error: 'empty' };
  if (att.bytes.length > MAX_OCR_BYTES) return { text: '', tables: [], error: 'too_large' };
  const folder = tempOcrFolder_();
  const blob = Utilities.newBlob(att.bytes, att.mimeType, att.name);
  let file;
  try {
    file = Drive.Files.insert(
      { title: 'ocr_' + att.name, mimeType: 'application/vnd.google-apps.document', parents: [{ id: folder.getId() }] },
      blob,
      { convert: true, ocr: true, ocrLanguage: ocrLanguage_() }
    );
  } catch (e) {
    const m = (e && e.message) ? e.message : String(e);
    return { text: '', tables: [], error: 'convert_failed: ' + m, encrypted: /password|encrypt/i.test(m) };
  }

  let text = '', tables = [];
  try {
    const doc = DocumentApp.openById(file.id);
    const body = doc.getBody();
    text = body.getText();
    const tbls = body.getTables();
    for (let i = 0; i < tbls.length; i++) {
      const rows = tbls[i].getNumRows();
      for (let r = 0; r < rows; r++) {
        const row = tbls[i].getRow(r);
        const cells = row.getNumCells();
        for (let c = 0; c + 1 < cells; c += 2) {
          const label = row.getCell(c).getText().trim();
          const value = row.getCell(c + 1).getText().trim();
          if (label) tables.push({ label: label, value: value });
        }
      }
    }
    doc.saveAndClose();
  } catch (e) {
    // keep whatever partial text we got
  }
  try { Drive.Files.remove(file.id); } catch (e) { /* ignore */ }

  let combined = text || '';
  if (tables.length) {
    combined += '\n' + tables.map(function (t) { return t.label + ': ' + t.value; }).join('\n');
  }
  return { text: combined, tables: tables, error: '' };
}

// ---- commit -----------------------------------------------------------------

function findKey_(keys, type) {
  for (let i = 0; i < keys.length; i++) { if (keys[i].type === type) return keys[i]; }
  return null;
}

function emptyFields_() {
  return {
    invoiceNo: '', invoiceDate: '', dueDate: '', amount: null, currency: '',
    tax: null, docType: 'invoice', confidence: 0, evidence: [],
    amountAmbiguous: false, isPortal: false
  };
}

function buildDetail_(f, routed, sourceKind) {
  const bits = ['tpl=' + (routed.template ? routed.template.name : 'generic')];
  if (routed.platform) bits.push('platform=' + routed.domain);
  bits.push('src=' + sourceKind);
  if (f.evidence && f.evidence.length) {
    bits.push('anchors=' + f.evidence.map(function (e) { return e.field + ':' + e.anchor; }).join(','));
  }
  return bits.join(' ');
}

/**
 * Persist one record: ledger row + key index, atomically in one batch each,
 * and update the in-memory seen set.
 */
function commitRecord_(recObj, keys, seen, stats) {
  const primary = findKey_(keys, 'ATT') || findKey_(keys, 'MSG');
  recObj.DedupeKey = primary ? primary.key : '';
  if (!isDryRun_()) {
    appendRows_('Ledger', [ledgerRow_(recObj)]);
    const rowNum = sheet_('Ledger').getLastRow();
    appendKeyIndex_(keyIndexEntries_(keys, {
      messageId: recObj.MessageId,
      attachmentName: recObj.AttachmentName,
      vendor: recObj.Vendor,
      invoiceNo: recObj.InvoiceNo
    }, rowNum));
  }
  keys.forEach(function (k) { seen[k.key] = true; });
  stats.records++;
  if (recObj.Status !== STATUS.OK) stats.review++;
}

function makeRecord_(source, routed, attName, f, status, detail, notes, sourceKind) {
  return {
    Timestamp: isoNow_(),
    MessageId: source.messageId,
    AttachmentName: attName,
    Vendor: routed.vendor,
    DocType: f.docType || 'invoice',
    InvoiceNo: f.invoiceNo || '',
    InvoiceDate: f.invoiceDate || '',
    DueDate: f.dueDate || '',
    Amount: (f.amount === null || f.amount === undefined) ? '' : f.amount,
    Currency: f.currency || '',
    Tax: (f.tax === null || f.tax === undefined) ? '' : f.tax,
    Status: status,
    Confidence: (f.confidence === undefined) ? '' : f.confidence,
    Source: sourceKind || '',
    SourceDetail: detail || '',
    Notes: notes || '',
    From: source.from,
    Subject: source.subject
  };
}

// ---- per-message processing -------------------------------------------------

function handleRecord_(source, routed, att, seen, stats) {
  const attName = att ? att.name : '';
  const attBytes = att ? att.bytes : null;

  // 1. cheap identity check before any expensive work
  const earlyKeys = buildKeys_({
    messageId: source.messageId, attachmentName: attName, attachmentBytes: attBytes,
    confidence: 0, invoiceNo: ''
  });
  const earlyDup = firstSeenKey_(earlyKeys, seen);
  if (earlyDup) { stats.skipped++; log_('INFO', 'duplicate (' + earlyDup.type + ') ' + attName); return { handled: true }; }

  // 2. obtain text
  let text = '', sourceKind = 'body', multiColumnRisk = false, encError = '';
  if (att) {
    const at = attachmentText_(att);
    text = at.text || '';
    sourceKind = at.kind;
    multiColumnRisk = !!at.multiColumnRisk;
    encError = at.error || '';
    if (at.encrypted) {
      const status = STATUS.ENCRYPTED;
      commitRecord_(makeRecord_(source, routed, attName, emptyFields_(), status, 'src=ocr enc=password', encError, 'ocr'), [], seen, stats);
      return { handled: true };
    }
  } else {
    text = source.bodyText || '';
    sourceKind = 'body';
  }

  // 3. extract
  const f = extractRecord_({
    text: text, sourceKind: sourceKind, vendor: routed.vendor,
    template: routed.template, jsonLd: source.jsonLd, multiColumnRisk: multiColumnRisk
  });

  // 4. dedupe again now that the content (CNT) key is available
  const keys = buildKeys_({
    messageId: source.messageId, attachmentName: attName, attachmentBytes: attBytes,
    confidence: f.confidence, invoiceNo: f.invoiceNo, amount: f.amount,
    currency: f.currency, invoiceDate: f.invoiceDate, vendor: routed.vendor
  });
  const dup = firstSeenKey_(keys, seen);
  if (dup) { stats.skipped++; log_('INFO', 'duplicate (' + dup.type + ') ' + attName); return { handled: true }; }

  // 5. status + commit
  const status = statusFor_(f, (text || '').trim().length);
  const detail = buildDetail_(f, routed, sourceKind);
  const notes = [];
  if (f.amountAmbiguous) notes.push('amount ambiguous');
  if (f.dateAmbiguous) notes.push('date ambiguous');
  if (multiColumnRisk) notes.push('multi-column (table-derived)');
  if (encError) notes.push(encError);
  if (f.confidence < 0.85 && status !== STATUS.OK) notes.push('low confidence');

  commitRecord_(makeRecord_(source, routed, attName, f, status, detail, notes.join('; '), sourceKind), keys, seen, stats);
  return { handled: true };
}

function processMessage_(messageId, seen, stats) {
  const msg = withRetry_(function () { return GmailApp.getMessageById(messageId); }, 3, 400, 'getMessage');
  if (!msg) { stats.skipped++; return; }
  const source = buildSource_(msg);
  const routed = route_(source.from, source.bodyText);

  let handled = false;
  const atts = source.attachments || [];
  for (let i = 0; i < atts.length; i++) {
    if (attachmentKind_(atts[i].mimeType, atts[i].name) === 'other') {
      log_('INFO', 'skip unsupported attachment: ' + atts[i].name);
      continue;
    }
    const r = handleRecord_(source, routed, atts[i], seen, stats);
    if (r.handled) handled = true;
  }
  if (!handled && (source.bodyText || '').trim()) {
    handleRecord_(source, routed, null, seen, stats);
  }
  stats.processed++;
}

// ---- queue draining ---------------------------------------------------------

function processQueue_(clock, seen, stats) {
  const pending = loadQueuePending_();
  for (let i = 0; i < pending.length; i++) {
    if (clock.expired()) { log_('INFO', 'time budget reached with ' + (pending.length - i) + ' still queued'); break; }
    const item = pending[i];
    try {
      processMessage_(item.messageId, seen, stats);
      setQueueStatus_(item.row, 'done');
    } catch (e) {
      const m = (e && e.message) ? e.message : String(e);
      if (isNotFound_(e)) {
        log_('WARN', 'message gone: ' + item.messageId);
        setQueueStatus_(item.row, 'done', 'not found');
      } else {
        log_('ERROR', 'process ' + item.messageId + ': ' + m);
        setQueueStatus_(item.row, 'error', m);
      }
    }
  }
}

// ---- entry points -----------------------------------------------------------

function heartbeatCheck_() {
  const last = cfg_(PROP.LAST_RUN_ISO, '');
  if (!last) return;
  const hrs = (Date.now() - Date.parse(last)) / 3600000;
  if (hrs > HEARTBEAT_WARN_HOURS) {
    alert_('No successful run for ' + hrs.toFixed(1) + 'h',
      'The invoice tracker has not completed a run recently. Check the trigger and quotas.');
  }
}

/** Main scheduled entry point. */
function run() {
  clearLog_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) { Logger.log('another run holds the lock; exiting'); return; }
  try {
    ensureSchema_();
    cleanupTempOcr_();
    compactQueue_();
    __QUEUED = null;
    heartbeatCheck_();

    const clock = newRunClock_();
    const stats = { processed: 0, records: 0, skipped: 0, review: 0 };
    const seen = loadSeenKeys_();

    discover_(clock);
    processQueue_(clock, seen, stats);

    setProp_(PROP.LAST_RUN_ISO, isoNow_());
    log_('INFO', 'run complete: processed=' + stats.processed + ' records=' + stats.records +
      ' skipped=' + stats.skipped + ' review=' + stats.review + ' dryRun=' + isDryRun_());
  } catch (e) {
    log_('ERROR', 'run failed: ' + (e && e.message ? e.message : e));
    alert_('Run failed', String(e && e.stack ? e.stack : e));
  } finally {
    flushLog_();
    lock.releaseLock();
  }
}

/** One-time setup: schema + label. Safe to re-run. */
function setup() {
  clearLog_();
  ensureSchema_();
  const labelId = resolveInvoiceLabelId_();
  flushLog_();
  const ssId = cfg_(PROP.SPREADSHEET_ID, '');
  const info = 'Spreadsheet: ' + (ssId || '(none yet)') + '\nLabel: ' + invoiceLabelName_() + ' (' + labelId + ')';
  Logger.log(info);
  return info;
}

/** Install an hourly time-driven trigger (idempotent). Run manually once. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyHours(1).create();
  Logger.log('hourly trigger installed');
}

/** Clear a stuck bootstrap so the next run re-seeds from scratch. */
function resetSync() {
  delProp_(PROP.LAST_HISTORY_ID);
  delProp_(PROP.BACKFILL_DONE);
  delProp_(PROP.BACKFILL_OFFSET);
  delProp_(PROP.BACKFILL_H0);
  Logger.log('sync state cleared');
}
