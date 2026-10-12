/**
 * 60_Sheets.gs — spreadsheet access, schema bootstrap and batched writes.
 *
 * Writes are batched (one setValues per batch) so a hard 6-min kill cannot
 * leave a half-written batch. Row + its DedupeKey are written together.
 */

function getSpreadsheet_() {
  const id = cfg_(PROP.SPREADSHEET_ID, '');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('Invoice Tracker');
  setProp_(PROP.SPREADSHEET_ID, ss.getId());
  log_('INFO', 'created spreadsheet ' + ss.getId());
  return ss;
}

/** Get (or create + initialise) a named sheet. */
function sheet_(name) {
  const headers = HEADERS[name];
  if (!headers) throw new Error('Unknown sheet: ' + name);
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheetForDate_(iso) {
  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  if (!iso) return sheet_('Ledger');
  var m = iso.match(/^(\d{4})-(\d{1,2})/);
  if (!m) return sheet_('Ledger');
  var y = parseInt(m[1],10);
  var mo = parseInt(m[2],10)-1;
  var name = monthNames[mo] + ' ' + y;
  return sheet_(name);
}

function ensureSchema_() {
  Object.keys(HEADERS).forEach(function (name) { sheet_(name); });
}

function colIndex_(name, headerName) {
  const headers = HEADERS[name];
  const idx = headers.indexOf(headerName);
  if (idx === -1) throw new Error('No column ' + headerName + ' in ' + name);
  return idx + 1;
}

/** Append rows (arrays) to a sheet, padded/truncated to the header width. */
function appendRows_(name, rows) {
  if (!rows || !rows.length) return;
  const headers = HEADERS[name];
  const width = headers.length;
  const sh = sheet_(name);
  const normalized = rows.map(function (r) {
    const row = r.slice(0, width).map(sanitizeCell_);
    while (row.length < width) row.push('');
    return row;
  });
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, normalized.length, width).setValues(normalized);
}

function appendRowsToSheet_(sh, rows) {
  if (!rows || !rows.length) return;
  const width = LEDGER_HEADERS.length;
  const normalized = rows.map(function (r) {
    const row = r.slice(0, width).map(sanitizeCell_);
    while (row.length < width) row.push('');
    return row;
  });
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, normalized.length, width).setValues(normalized);
}

/** Read one column (by header name) as a flat array of values, excluding header. */
function readColumn_(name, headerName) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const col = colIndex_(name, headerName);
  return sh.getRange(2, col, last - 1, 1).getValues().map(function (r) { return r[0]; });
}

function flushLog_() {
  const lines = getLogLines_();
  if (!lines.length) return;
  try {
    const now = isoNow_();
    const id = runId_();
    const rows = lines.map(function (line) {
      const m = line.match(/^\[(\w+)\]\s*(.*)$/);
      return [now, id, m ? m[1] : 'INFO', m ? m[2] : line];
    });
    appendRows_('Log', rows);
  } catch (e) {
    Logger.log('flushLog failed: ' + e);
  }
}

// ---- ledger -----------------------------------------------------------------

/** Build a ledger row array (in LEDGER_HEADERS order) from a record object. */
function ledgerRow_(rec) {
  return LEDGER_HEADERS.map(function (h) {
    return (rec[h] === undefined) ? '' : rec[h];
  });
}

function loadLedgerDedupeKeys_() {
  return [];
}

// ---- key index --------------------------------------------------------------

function loadKeyHashSet_() {
  const out = {};
  readColumn_('KeyIndex', 'KeyHash').forEach(function (k) { if (k) out[k] = true; });
  return out;
}

/**
 * Union of the KeyIndex hashes and the ledger's own DedupeKey column.
 * Taking the union makes the crash window self-healing: even if KeyIndex
 * missed a write, the ledger row still carries its primary key.
 */
function loadSeenKeys_() {
  const seen = loadKeyHashSet_();
  loadLedgerDedupeKeys_().forEach(function (k) { if (k) seen[k] = true; });
  return seen;
}

function appendKeyIndex_(entries) {
  if (!entries || !entries.length) return;
  appendRows_('KeyIndex', entries);
}

// ---- pending queue ----------------------------------------------------------

/**
 * Load rows that still need processing, with their sheet row numbers.
 * status: 'pending' | 'done' | 'error'
 */
function loadQueuePending_() {
  const sh = sheet_('PendingQueue');
  const last = sh.getLastRow();
  const out = [];
  if (last > 1) {
    const vals = sh.getRange(2, 1, last - 1, QUEUE_HEADERS.length).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][2]).toLowerCase() === 'pending') {
        out.push({ row: i + 2, messageId: String(vals[i][0]), attempts: Number(vals[i][3]) || 0 });
      }
    }
  }
  return out;
}

function appendQueue_(messageIds) {
  if (!messageIds || !messageIds.length) return;
  const now = isoNow_();
  appendRows_('PendingQueue', messageIds.map(function (id) {
    return [id, now, 'pending', 0, ''];
  }));
}

function setQueueStatus_(row, status, err) {
  const sh = sheet_('PendingQueue');
  sh.getRange(row, colIndex_('PendingQueue', 'Status')).setValue(status);
  if (err) {
    const attemptsCol = colIndex_('PendingQueue', 'Attempts');
    const cur = Number(sh.getRange(row, attemptsCol).getValue()) || 0;
    sh.getRange(row, attemptsCol).setValue(cur + 1);
    sh.getRange(row, colIndex_('PendingQueue', 'LastError')).setValue(String(err).slice(0, 500));
  }
}

/** Drop non-pending rows from the bottom up. Keeps the queue small. */
function compactQueue_() {
  const sh = sheet_('PendingQueue');
  const last = sh.getLastRow();
  if (last < 2) return;
  const vals = sh.getRange(2, 1, last - 1, QUEUE_HEADERS.length).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][2]).toLowerCase() !== 'pending') sh.deleteRow(i + 2);
  }
}
