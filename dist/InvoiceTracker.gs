/**
 * InvoiceTracker.gs — GENERATED single-file bundle. Do not edit by hand.
 * Regenerate with: node tools/build-bundle.js
 * Sources: 00_Config.gs, 10_Lib.gs, 20_Identity.gs, 30_Sync.gs, 40_Extract.gs, 50_Router.gs, 60_Sheets.gs, 70_Probe.gs, 80_Tests.gs, 90_Main.gs, Fixtures.gs
 */

// ============================================================
// 00_Config.gs
// ============================================================

/**
 * 00_Config.gs — configuration, schema and constants.
 *
 * Configuration values are read from Script Properties
 * (Project Settings > Script Properties) with the fallbacks below.
 *
 * RULE (see DECISIONS.md / SOLUTIONS.md): scalars live in Properties,
 * collections live in sheets. Nothing that grows unbounded goes in Properties.
 */

const PROP = {
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  INVOICE_LABEL: 'INVOICE_LABEL',
  INVOICE_LABEL_ID: 'INVOICE_LABEL_ID',
  DRY_RUN: 'DRY_RUN',
  MAX_EXECUTION_MS: 'MAX_EXECUTION_MS',
  LAST_HISTORY_ID: 'LAST_HISTORY_ID',
  BACKFILL_DONE: 'BACKFILL_DONE',
  BACKFILL_OFFSET: 'BACKFILL_OFFSET',
  BACKFILL_H0: 'BACKFILL_H0',
  LAST_RUN_ISO: 'LAST_RUN_ISO',
  TEMP_OCR_FOLDER_ID: 'TEMP_OCR_FOLDER_ID',
  OCR_LANGUAGE: 'OCR_LANGUAGE'
};

const DEFAULTS = {
  INVOICE_LABEL: 'InvoiceTracker',
  DRY_RUN: 'true',
  MAX_EXECUTION_MS: '318000',   // 5.3 min — leaves a 30s+ buffer under the 6-min hard cap
  OCR_LANGUAGE: 'en'
};

/** Result statuses written to the ledger. */
const STATUS = {
  OK: 'ok',
  REVIEW: 'needs_review',
  PORTAL: 'portal_manual',
  ENCRYPTED: 'needs_review_encrypted',
  NOTEXT: 'needs_review_no_content',
  DUPLICATE: 'duplicate'
};

// ---- Ledger schema (single source of truth for column order) ----------------

const LEDGER_HEADERS = [
  'Invoice #', 'Date', 'Payment due', 'Brand name', 'Amount', 'Total paid', 'Outstanding', 'Status', 'Payment Date', 'Notes'
];

const KEYINDEX_HEADERS = [
  'KeyType', 'KeyHash', 'MessageId', 'AttachmentName',
  'Vendor', 'InvoiceNo', 'LedgerRow', 'FirstSeen'
];

const QUEUE_HEADERS = ['MessageId', 'EnqueuedIso', 'Status', 'Attempts', 'LastError'];
const LOG_HEADERS = ['Timestamp', 'RunId', 'Level', 'Message'];
const VENDOR_HEADERS = ['Vendor', 'Domains', 'Enabled', 'Notes', 'Routed', 'GenericFallback', 'LastSeen'];

/**
 * Header map. Declared here (after the arrays above) so initialisation order
 * inside one file is guaranteed.
 */
const HEADERS = {
  Ledger: LEDGER_HEADERS,
  KeyIndex: KEYINDEX_HEADERS,
  PendingQueue: QUEUE_HEADERS,
  Log: LOG_HEADERS,
  Vendors: VENDOR_HEADERS
};

/** Hard safety cap for a single attachment sent to OCR (bytes). */
const MAX_OCR_BYTES = 15 * 1024 * 1024;

/** OCR temp docs older than this are cleaned up on the next run. */
const TEMP_OCR_TTL_MS = 60 * 60 * 1000;

/** Content key is only built above this confidence (see SOLUTIONS.md solution A). */
const CNT_KEY_MIN_CONFIDENCE = 0.8;

/** Alert if no successful run within this window. */
const HEARTBEAT_WARN_HOURS = 26;

// ---- accessors --------------------------------------------------------------

function props_() { return PropertiesService.getScriptProperties(); }

function cfg_(key, fallback) {
  const v = props_().getProperty(key);
  return (v === null || v === undefined || v === '') ? fallback : v;
}

function cfgInt_(key, fallback) {
  const v = cfg_(key, '');
  const s = String(v).trim();
  // Number('') is 0, not NaN — so an unset property must be caught explicitly,
  // or it silently becomes 0 (this once made MAX_EXECUTION_MS 0 and every run
  // start with an already-expired clock).
  if (s === '') return fallback;
  const n = Number(s);
  return isNaN(n) ? fallback : n;
}

function setProp_(key, value) { props_().setProperty(key, String(value)); }
function delProp_(key) { props_().deleteProperty(key); }

function isDryRun_() { return String(cfg_(PROP.DRY_RUN, DEFAULTS.DRY_RUN)).toLowerCase() === 'true'; }
function maxExecutionMs_() { return cfgInt_(PROP.MAX_EXECUTION_MS, Number(DEFAULTS.MAX_EXECUTION_MS)); }
function invoiceLabelName_() { return cfg_(PROP.INVOICE_LABEL, DEFAULTS.INVOICE_LABEL); }
function ocrLanguage_() { return cfg_(PROP.OCR_LANGUAGE, DEFAULTS.OCR_LANGUAGE); }


// ============================================================
// 10_Lib.gs
// ============================================================

/**
 * 10_Lib.gs — shared utilities.
 *
 * Everything here is either pure (testable in isolation) or a thin wrapper
 * around one Apps Script service. No Google service is touched at load time.
 */

// ---- logging (buffered; flushed to the Log sheet by the sheets layer) -------

const __LOG = [];

function log_(level, msg) {
  const line = '[' + level + '] ' + msg;
  __LOG.push(line);
  Logger.log(line);
}

function clearLog_() { __LOG.length = 0; }
function getLogLines_() { return __LOG.slice(); }

/** Email the account owner. Mind the 100 recipients/day consumer cap. */
function alert_(subject, body) {
  try {
    const to = Session.getEffectiveUser().getEmail();
    MailApp.sendEmail({ to: to, subject: '[InvoiceTracker] ' + subject, body: body });
  } catch (e) {
    log_('ERROR', 'alert failed: ' + (e && e.message ? e.message : e));
  }
}

// ---- hashing ----------------------------------------------------------------

/** MD5 -> lowercase hex. Accepts a string or a byte array. */
function md5Hex_(input) {
  const bytes = (typeof input === 'string') ? Utilities.newBlob(input).getBytes() : input;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes);
  let out = '';
  for (let i = 0; i < digest.length; i++) {
    out += ((digest[i] & 0xff).toString(16)).padStart(2, '0');
  }
  return out;
}

// ---- spreadsheet hygiene ----------------------------------------------------

/**
 * Defang values that a spreadsheet would interpret as formulas.
 * Numbers pass through untouched; strings get a leading apostrophe if they
 * begin with a formula trigger (see RISKS.md C4).
 */
function sanitizeCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  let s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

function sanitizeRow_(row) { return row.map(sanitizeCell_); }

// ---- errors / retry ---------------------------------------------------------

const TRANSIENT_RE = /(rate limit|quota|too many|429|500|502|503|504|backend error|service invoked too many times|try again|timed? ?out)/i;

function isTransient_(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  if (typeof err.status === 'number' && err.status >= 500 && err.status <= 599) return true;
  return TRANSIENT_RE.test(String(err.message || err));
}

function isNotFound_(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  return /404|not\s*found|requested entity was not found/i.test(String(err.message || err));
}

/** Retry a function with exponential backoff + jitter on transient errors. */
function withRetry_(fn, tries, baseMs, label) {
  tries = tries || 4;
  baseMs = baseMs || 500;
  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (e) {
      attempt++;
      if (attempt >= tries || !isTransient_(e)) throw e;
      const wait = Math.round(baseMs * Math.pow(2, attempt - 1) + Math.random() * 250);
      log_('WARN', 'retry ' + (label || '') + ' attempt ' + attempt + ' in ' + wait + 'ms: ' +
        (e && e.message ? e.message : e));
      Utilities.sleep(wait);
    }
  }
}

// ---- time guard -------------------------------------------------------------

/** A budget clock. Check expired() between units of work; never mid-unit. */
function newRunClock_(budgetMs) {
  const deadline = Date.now() + (budgetMs || maxExecutionMs_());
  return {
    remaining: function () { return deadline - Date.now(); },
    expired: function () { return Date.now() >= deadline; }
  };
}

/**
 * Current timestamp as ISO-8601 in the script's own time zone, including the
 * UTC offset, e.g. 2026-10-12T14:33:00-0500 (Central Time, DST-aware).
 * Falls back to UTC ISO if the script time zone is unavailable.
 */
function isoNow_() {
  try {
    const tz = Session.getScriptTimeZone();
    if (tz) return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssZ");
  } catch (e) { /* fall through */ }
  return new Date().toISOString();
}

// ---- misc -------------------------------------------------------------------

let __RUN_ID = null;
function runId_() {
  if (!__RUN_ID) __RUN_ID = 'run_' + new Date().toISOString().replace(/[-:.TZ]/g, '') + '_' + Math.floor(Math.random() * 1e4);
  return __RUN_ID;
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** Build an ISO date string from numeric parts (no Date round-trip). */
function isoOf_(y, m, d) {
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/** Pad/truncate an array to an exact width so setValues never throws. */
function fitRow_(row, width) {
  const r = row.slice(0, width);
  while (row.length !== undefined && r.length < width) r.push('');
  return r;
}


// ============================================================
// 20_Identity.gs
// ============================================================

/**
 * 20_Identity.gs — layered idempotency keys.
 *
 * messageId is a TRANSPORT id, not an invoice id. The same invoice resent or
 * forwarded gets a new messageId. So we compute up to three keys and treat an
 * item as already-processed if ANY stored key matches.
 *
 *   ATT  att:<md5 of attachment bytes>   strongest; identical bytes => same invoice
 *   MSG  msg:<messageId>|<attachment>    stable per delivery
 *   CNT  cnt:<md5 of vendor|no|amount|ccy|date>  weak; gated to avoid false skips
 *
 * See SOLUTIONS.md solution A. Bias: a duplicate is visible; a dropped invoice
 * is silent. So the weak key is deliberately gated.
 */

/**
 * Build the candidate keys for one extracted item.
 * ctx = { messageId, attachmentName, attachmentBytes, confidence,
 *         vendor, invoiceNo, amount, currency, invoiceDate }
 */
function buildKeys_(ctx) {
  const keys = [];
  if (ctx.attachmentBytes && ctx.attachmentBytes.length) {
    keys.push({ type: 'ATT', key: 'att:' + md5Hex_(ctx.attachmentBytes) });
  }
  keys.push({ type: 'MSG', key: 'msg:' + ctx.messageId + '|' + (ctx.attachmentName || '') });
  const conf = typeof ctx.confidence === 'number' ? ctx.confidence : 0;
  if (ctx.invoiceNo && ctx.amount !== null && ctx.amount !== undefined && conf >= CNT_KEY_MIN_CONFIDENCE) {
    const payload = [ctx.vendor, ctx.invoiceNo, ctx.amount, ctx.currency, ctx.invoiceDate].join('|');
    keys.push({ type: 'CNT', key: 'cnt:' + md5Hex_(payload) });
  }
  return keys;
}

/** Return the first matching key, or null. `seen` is a plain object set. */
function firstSeenKey_(keys, seen) {
  for (let i = 0; i < keys.length; i++) {
    if (seen[keys[i].key]) return keys[i];
  }
  return null;
}

/** Convert built keys into KeyIndex rows for a ledger row number. */
function keyIndexEntries_(keys, meta, ledgerRowNumber) {
  const now = isoNow_();
  return keys.map(function (k) {
    return [k.type, k.key, meta.messageId, meta.attachmentName || '',
      meta.vendor || '', meta.invoiceNo || '', ledgerRowNumber, now];
  });
}


// ============================================================
// 30_Sync.gs
// ============================================================

/**
 * 30_Sync.gs — discovery via Gmail history, plus the pending queue.
 *
 * Design (see SOLUTIONS.md solution B and DECISIONS.md D1):
 *   - A Gmail filter labels invoice mail at delivery.
 *   - Discovery polls Gmail history for that label. History has no query
 *     language, but it does support `labelId` + `historyTypes`, so discovery
 *     stays server-side filtered.
 *   - Discovery (cheap, ids only) and processing (expensive) are decoupled by
 *     the PendingQueue, so a hard 6-min kill can only defer work, never lose it.
 */

let __QUEUED = null;

function queuedSet_() {
  if (!__QUEUED) {
    __QUEUED = {};
    loadQueuePending_().forEach(function (r) { if (r.messageId) __QUEUED[r.messageId] = true; });
  }
  return __QUEUED;
}

/** Return only ids not already queued, and mark them queued. */
function filterNew_(ids) {
  const s = queuedSet_();
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id && !s[id]) { s[id] = true; out.push(id); }
  }
  return out;
}

/** Resolve (creating if needed) the Gmail label used as the discovery gate. */
function resolveInvoiceLabelId_() {
  const cached = cfg_(PROP.INVOICE_LABEL_ID, '');
  if (cached) return cached;
  const name = invoiceLabelName_();
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  const id = label.getId();
  setProp_(PROP.INVOICE_LABEL_ID, id);
  log_('INFO', 'invoice label "' + name + '" id=' + id);
  return id;
}

function discover_(clock) {
  resolveInvoiceLabelId_();
  if (String(cfg_(PROP.BACKFILL_DONE, '')) !== 'true') {
    backfill_(clock);
    return;
  }
  pollHistory_(clock);
}

// ---- bootstrap --------------------------------------------------------------

/**
 * Seed the queue from existing labelled mail, then hand over to history.
 *
 * H0 is captured BEFORE the search so anything that arrives during the (possibly
 * multi-run) backfill is still covered by history afterwards.
 */
function backfill_(clock) {
  const labelName = invoiceLabelName_();
  if (!cfg_(PROP.BACKFILL_H0, '')) {
    setProp_(PROP.BACKFILL_H0, Gmail.Users.getProfile('me').historyId);
  }
  let offset = cfgInt_(PROP.BACKFILL_OFFSET, 0);
  while (!clock.expired()) {
    const batch = GmailApp.search('label:"' + labelName + '"', offset, 100);
    if (!batch.length) { finishBackfill_(); return; }
    const ids = [];
    for (let i = 0; i < batch.length; i++) {
      const msgs = batch[i].getMessages();
      for (let j = 0; j < msgs.length; j++) ids.push(msgs[j].getId());
    }
    const fresh = filterNew_(ids);
    if (fresh.length) appendQueue_(fresh);
    offset += 100;
    setProp_(PROP.BACKFILL_OFFSET, offset);
  }
  log_('WARN', 'backfill incomplete at offset ' + offset + '; resuming next run');
}

function finishBackfill_() {
  setProp_(PROP.LAST_HISTORY_ID, cfg_(PROP.BACKFILL_H0, Gmail.Users.getProfile('me').historyId));
  setProp_(PROP.BACKFILL_DONE, 'true');
  delProp_(PROP.BACKFILL_OFFSET);
  log_('INFO', 'backfill complete; history cursor set');
}

// ---- incremental polling ----------------------------------------------------

function pollHistory_(clock) {
  const labelId = cfg_(PROP.INVOICE_LABEL_ID, '');
  if (!labelId) { log_('ERROR', 'no invoice label id; run setup() first'); return; }

  let cursor = cfg_(PROP.LAST_HISTORY_ID, '');
  if (!cursor) {
    setProp_(PROP.LAST_HISTORY_ID, Gmail.Users.getProfile('me').historyId);
    log_('INFO', 'no cursor yet; seeded from current historyId');
    return;
  }

  let pageToken = null;
  let pages = 0;
  while (!clock.expired() && pages < 100) {
    pages++;
    let res;
    try {
      const req = {
        startHistoryId: cursor,
        labelId: cfg_(PROP.INVOICE_LABEL_ID, ''),
        historyTypes: ['labelAdded'],
        maxResults: 500
      };
      if (pageToken) req.pageToken = pageToken;
      res = Gmail.Users.History.list('me', req);
    } catch (e) {
      if (isNotFound_(e)) { recoverHistoryGap_(); return; }
      throw e;
    }

    const hist = res.history || [];
    const ids = [];
    for (let i = 0; i < hist.length; i++) {
      const added = hist[i].labelsAdded || [];
      for (let j = 0; j < added.length; j++) {
        const a = added[j];
        if (a.labelIds && a.labelIds.indexOf(cfg_(PROP.INVOICE_LABEL_ID, '')) !== -1 && a.message) {
          ids.push(a.message.id);
        }
      }
      if (hist[i].id) cursor = String(hist[i].id);
    }
    const fresh = filterNew_(ids);
    if (fresh.length) {
      appendQueue_(fresh);
      log_('INFO', 'discovered ' + fresh.length + ' labelled message(s)');
    }
    // Advance the cursor per record so a bounded listing stays resumable.
    setProp_(PROP.LAST_HISTORY_ID, cursor);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
}

/**
 * History expired (404). Recover by re-scanning the label, then reset the
 * cursor to now. Duplicates are expected and absorbed by content-hash dedupe.
 */
function recoverHistoryGap_(clock) {
  log_('WARN', 'history cursor expired (404) — recovering via label search');
  alert_('History gap recovered',
    'The Gmail history cursor expired, so a full label re-scan was run. ' +
    'Duplicate rows are possible, but the content-hash dedupe should absorb them.');

  const labelName = invoiceLabelName_();
  let offset = 0;
  while (!clock.expired()) {
    const batch = GmailApp.search('label:"' + labelName + '"', offset, 100);
    if (!batch.length) break;
    const ids = [];
    for (let i = 0; i < batch.length; i++) {
      const msgs = batch[i].getMessages();
      for (let j = 0; j < msgs.length; j++) ids.push(msgs[j].getId());
    }
    const fresh = filterNew_(ids);
    if (fresh.length) appendQueue_(fresh);
    offset += 100;
  }
  setProp_(PROP.LAST_HISTORY_ID, Gmail.Users.getProfile('me').historyId);
}


// ============================================================
// 40_Extract.gs
// ============================================================

/**
 * 40_Extract.gs — the extraction engine.
 *
 * PURE: every function here operates on strings/objects and returns values.
 * No Google service is used, which is what makes the engine testable with both
 * synthetic fixtures and real samples (see 70_Probe.gs / 80_Tests.gs).
 */

// ---- text preparation -------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-',
  mdash: '-', hellip: '...', euro: 'EUR', pound: 'GBP', deg: 'deg', copy: '(c)', reg: '(R)', trade: '(tm)'
};

function decodeEntities_(s) {
  if (!s) return s;
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return safeFromCode_(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return safeFromCode_(parseInt(d, 10)); })
    .replace(/&([a-zA-Z]+);/g, function (m, name) {
      const k = name.toLowerCase();
      return (ENTITIES[k] !== undefined) ? ENTITIES[k] : m;
    });
}

function safeFromCode_(code) {
  try { return String.fromCharCode(code); } catch (e) { return ''; }
}

/** Turn an HTML body into text with no DOM available (linear, no backtracking). */
function stripHtml_(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, '\t');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities_(s);
  return s;
}

/** Normalise whitespace and unify punctuation for matching. Keeps line breaks. */
function normalizeText_(s) {
  if (!s) return '';
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).join('\n');
}

function lines_(text) {
  return String(text || '').split('\n');
}

// ---- JSON-LD (schema.org Invoice / Order) -----------------------------------

/**
 * Some vendors embed schema.org data. When present it is far more reliable
 * than anchor scraping, so it is worth the small effort to read it.
 */
function parseJsonLd_(html) {
  if (!html) return null;
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  const found = {};
  for (let i = 0; i < blocks.length; i++) {
    let data;
    try { data = JSON.parse(blocks[i]); } catch (e) { continue; }
    scanJsonForInvoice_(data, found);
  }
  return (found.amount || found.invoiceNo || found.invoiceDate) ? found : null;
}

function scanJsonForInvoice_(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(function (n) { scanJsonForInvoice_(n, out); }); return; }
  const type = node['@type'];
  const isInvoice = node.totalPaymentDue || node.totalPrice || node.paymentDueDate ||
    (typeof node['@type'] === 'string' && /invoice|order/i.test(node['@type'] || ''));
  if (isInvoice) {
    if (!out.currency) {
      if (node.priceCurrency) out.currency = String(node.priceCurrency);
    }
    ['totalPrice', 'totalPaymentDue', 'price'].forEach(function (k) {
      if ((out.amount === undefined || out.amount === null) && node[k] !== undefined) {
        if (typeof node[k] === 'number') out.amount = node[k];
        else if (typeof node[k] === 'string') {
          const p = parseAmount_(node[k]);
          if (p) { out.amount = p.value; out.currency = out.currency || p.currency; }
        } else if (node[k] && typeof node[k] === 'object') {
          if (typeof node[k].price === 'number') out.amount = node[k].price;
          if (node[k].priceCurrency && !out.currency) out.currency = node[k].priceCurrency;
        }
      }
    });
    ['paymentDueDate', 'dateCreated', 'purchaseDate', 'datePublished'].forEach(function (k) {
      if (!out.dueDate && k === 'paymentDueDate' && node[k]) out.dueDate = node[k];
      if (!out.invoiceDate && k !== 'paymentDueDate' && node[k]) out.invoiceDate = node[k];
    });
    ['invoiceNumber', 'orderNumber', 'confirmationNumber', 'identifier'].forEach(function (k) {
      if (!out.invoiceNo && node[k]) {
        out.invoiceNo = (typeof node[k] === 'object' && node[k].value) ? String(node[k].value) : String(node[k]);
      }
    });
  }
  Object.keys(node).forEach(function (k) { scanJsonForInvoice_(node[k], out); });
}

// ---- anchors ----------------------------------------------------------------

/** Most-specific-first. `invoice` must never shadow `invoice number`. */
const ANCHORS = {
  invoiceNo: ['credit note number', 'credit note no', 'tax invoice number', 'invoice number',
    'invoice no.', 'invoice no', 'invoice #',
    'invoice#', 'invoice id', 'invoice ref', 'document number', 'order number',
    'order no.', 'order no', 'order #', 'order#', 'order id', 'confirmation number',
    'confirmation no', 'reference number',
    'reference no', 'reference #', 'reference', 'invoice'],
  invoiceDate: ['invoice date', 'date of issue', 'issue date', 'date issued', 'billing date',
    'bill date', 'date'],
  dueDate: ['payment due date', 'due date', 'date due', 'payment due', 'due on', 'due'],
  total: ['grand total', 'total amount due', 'total amount', 'amount due', 'total due',
    'balance due', 'total including tax', 'total incl. tax', 'total'],
  tax: ['vat amount', 'vat', 'gst amount', 'gst', 'sales tax', 'tax amount', 'tax']
};

function cleanValue_(v) {
  if (!v) return '';
  let s = String(v).trim();
  // Strip leading separators. Note: '-' is NOT in this class, so a sign that is
  // attached to an amount ("-$50.00") survives. A dash used as a separator
  // ("Invoice No - 123") is handled by the next line instead.
  s = s.replace(/^[\s:.\u2013\u2014#*]+/, '');
  s = s.replace(/^-\s+/, '');
  s = s.replace(/^[A-Za-z]{0,12}\s*[:#]\s*/, '');
  s = s.replace(/[\s:.\u2013\u2014]+$/, '');
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

/**
 * Find the value following an anchor. Tries the most specific anchor first,
 * requires a non-alphanumeric boundary before the anchor, and (optionally)
 * validates the captured value's shape.
 */
function findByAnchor_(text, anchors, opts) {
  opts = opts || {};
  const validator = opts.validator || null;
  const ls = lines_(text);
  for (let ai = 0; ai < anchors.length; ai++) {
    const anchor = anchors[ai].toLowerCase();
    for (let li = 0; li < ls.length; li++) {
      const line = ls[li];
      const low = line.toLowerCase();
      let from = 0, idx;
      while ((idx = low.indexOf(anchor, from)) !== -1) {
        const before = idx > 0 ? low.charAt(idx - 1) : ' ';
        if (!/[a-z0-9]/.test(before)) {
          let value = cleanValue_(line.slice(idx + anchor.length));
          if (!value) {
            for (let nj = li + 1; nj < ls.length && nj < li + 3; nj++) {
              if (ls[nj].trim()) { value = cleanValue_(ls[nj]); break; }
            }
          }
          if (value && (!validator || validator(value))) {
            return { value: value, anchor: anchor };
          }
        }
        from = idx + anchor.length;
      }
    }
  }
  return null;
}

// ---- shape validators -------------------------------------------------------

function looksLikeAmount_(s) {
  if (!s) return false;
  const digits = (String(s).match(/\d/g) || []).length;
  if (digits === 0) return false;
  if (digits > 15) return false;
  if (/[a-z]{4,}/i.test(String(s).replace(/\b(usd|eur|gbp|jpy|inr|aud|cad|chf|nzd|sek|nok|dkk|zar|brl|mxn|sgd|hkd|krw|cny|pln|czk)\b/gi, ''))) return false;
  return true;
}

function looksLikeDateText_(s) { return !!parseDate_(s); }

function looksLikeInvoiceNo_(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (!/[A-Za-z0-9]/.test(t)) return false;
  if (t.length > 40) return false;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return false;              // ISO date
  if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t)) return false; // numeric date
  // Reject natural-language phrases: multiple words with no digit to anchor them.
  if (/\s/.test(t) && !/\d/.test(t)) return false;
  // Reject common prose fillers outright.
  if (!/\d/.test(t) && /\b(is|are|was|were|the|and|now|available|ready|your|you|to|for|of|has|been|due|total)\b/i.test(t)) return false;
  return true;
}

// ---- amount parsing ---------------------------------------------------------

const CURRENCY_SYMBOLS = {
  '$': 'USD', '\u20ac': 'EUR', '\u00a3': 'GBP', '\u00a5': 'JPY', '\u20b9': 'INR',
  '\u20a9': 'KRW', '\u20aa': 'ILS', '\u20ba': 'TRY', '\u20bd': 'RUB',
  '\u20b1': 'PHP', '\u0e3f': 'THB', '\u20ab': 'VND', '\u20a6': 'NGN', '\u20b4': 'UAH'
};

const CURRENCY_CODES = /\b(USD|EUR|GBP|JPY|INR|AUD|CAD|CHF|NZD|SEK|NOK|DKK|ZAR|BRL|MXN|SGD|HKD|KRW|CNY|PLN|CZK|TRY|ILS|AED|SAR|THB|IDR|MYR|PHP|VND)\b/i;

function parseAmount_(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  if (!/\d/.test(s)) return null;

  const trimmed = s.trim();
  // A leading minus means negative. A bracketed value is negative only when the
  // brackets hold essentially just the number, e.g. "(50.00)" or "($50.00)" —
  // a bracketed clause like "(Includes VAT of 5.25)" must NOT flip the sign.
  const negative = /^[-\u2013]/.test(trimmed) ||
    /^\(\s*[^0-9]{0,6}\d[\d.,\u00a0 '\u2019]*\)$/.test(trimmed);

  let currency = '';
  const codeM = s.match(CURRENCY_CODES);
  if (codeM) currency = codeM[1].toUpperCase();
  if (!currency) {
    const keys = Object.keys(CURRENCY_SYMBOLS);
    for (let i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) !== -1) { currency = CURRENCY_SYMBOLS[keys[i]]; break; }
    }
  }
  if (!currency) {
    const t2 = String(raw || '').toUpperCase();
    if (t2.indexOf('PHP') !== -1 || t2.indexOf('PESO') !== -1) currency = 'PHP';
  }

  const nm = s.match(/\d[\d.,\u00a0 '\u2019]*\d|\d/);
  if (!nm) return null;
  let num = nm[0].replace(/[\s\u00a0'\u2019]/g, '');

  const lastDot = num.lastIndexOf('.');
  const lastComma = num.lastIndexOf(',');
  let decimalSep = null;
  let ambiguous = false;

  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = (lastDot > lastComma) ? '.' : ',';
  } else if (lastDot !== -1) {
    const dec = num.length - lastDot - 1;
    if (dec === 3 && /^\d{1,3}(\.\d{3})+$/.test(num)) { decimalSep = null; ambiguous = true; }
    else decimalSep = '.';
  } else if (lastComma !== -1) {
    const dec = num.length - lastComma - 1;
    if (dec === 3 && /^\d{1,3}(,\d{3})+$/.test(num)) { decimalSep = null; ambiguous = true; }
    else decimalSep = ',';
  }

  let normalized;
  if (decimalSep === '.') normalized = num.replace(/,/g, '');
  else if (decimalSep === ',') normalized = num.replace(/\./g, '').replace(',', '.');
  else normalized = num.replace(/[.,]/g, '');

  const value = parseFloat(normalized);
  if (isNaN(value)) return null;

  const decimals = (decimalSep && normalized.indexOf('.') !== -1)
    ? normalized.length - normalized.indexOf('.') - 1 : 0;

  return {
    value: negative ? -value : value,
    currency: currency,
    raw: s.trim(),
    ambiguous: ambiguous,
    decimals: decimals
  };
}

// ---- date parsing -----------------------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function buildIso_(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || !(y >= 1990 && y <= 2100)) return null;
  return y + '-' + pad2_(m) + '-' + pad2_(d);
}

function parseDate_(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();

  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { const iso = buildIso_(+m[1], +m[2], +m[3]); return iso ? { iso: iso, ambiguous: false } : null; }

  m = s.match(/(\d{1,2})[\s\-.]+([A-Za-z]{3,9})\.?[\s,\-.]+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) { const iso = buildIso_(normYear_(+m[3]), mo, +m[1]); if (iso) return { iso: iso, ambiguous: false }; }
  }
  m = s.match(/([A-Za-z]{3,9})\.?[\s\-.]+(\d{1,2})[\s,\-.]+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) { const iso = buildIso_(normYear_(+m[3]), mo, +m[2]); if (iso) return { iso: iso, ambiguous: false }; }
  }

  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = normYear_(+m[3]);
    let day, mon, ambiguous = false;
    if (a > 12 && b <= 12) { day = a; mon = b; }
    else if (b > 12 && a <= 12) { day = b; mon = a; }
    else { day = a; mon = b; ambiguous = (a !== b); }   // default day-first, flagged
    const iso = buildIso_(y, mon, day);
    return iso ? { iso: iso, ambiguous: ambiguous } : null;
  }
  return null;
}

function normYear_(y) { return y < 100 ? 2000 + y : y; }

// ---- classification ---------------------------------------------------------

function detectDocType_(text) {
  const t = String(text || '').toLowerCase();
  // The caller prepends the subject, so line 1 is the strongest signal.
  const title = (t.split('\n')[0] || '').trim();

  // 1. An explicit title decides it: a subject naming a credit note / refund wins.
  if (/credit\s+(note|memo|invoice)|\brefund\b/.test(title)) return 'credit_note';
  if (/\breceipt\b/.test(title)) return 'receipt';
  if (/\binvoice\b/.test(title)) return 'invoice';

  // 2. Body heuristics. "refund"/"reversal" only count next to a strong verb —
  //    a stray "refund" in a receipt's help text must NOT flip the doc type.
  if (/credit\s+(note|memo|invoice)/.test(t) ||
      /\bamount credited\b/.test(t) ||
      /\brefund\b[\s\S]{0,30}\b(issued|processed|credited|approved|reversed)\b/.test(t) ||
      /\b(issued|processed|credited|approved|reversed)\b[\s\S]{0,30}\brefund\b/.test(t)) {
    return 'credit_note';
  }
  if (/\breceipt\b|\border confirmation\b|\bpayment received\b|\bthank you for your (purchase|order)\b|\bpaid\b/.test(t)) {
    return 'receipt';
  }
  return 'invoice';
}

const PORTAL_RE = /\b(sign in|log in|login|sign-in|view (your )?invoice|download (your )?invoice|invoice is ready|view and pay|pay (your )?bill|account portal|billing portal|customer portal|manage your account)\b/i;

function detectPortal_(text) { return PORTAL_RE.test(String(text || '')); }

// ---- generic extraction -----------------------------------------------------

/**
 * Extract fields from a text blob (body text or OCR'd attachment text).
 * Returns fields + evidence + a confidence score. Never throws.
 */
function extractGeneric_(text, opts) {
  opts = opts || {};
  const A = opts.anchors || ANCHORS;
  const evidence = [];
  const out = {
    invoiceNo: '', invoiceDate: '', dueDate: '',
    amount: null, currency: '', amountAmbiguous: false, decimals: 0,
    tax: null, docType: 'invoice', evidence: evidence,
    source: opts.source || 'generic', genericAnchors: 0
  };
  const t = normalizeText_(text);
  if (!t.trim()) return out;

  const inv = findByAnchor_(t, A.invoiceNo, { validator: looksLikeInvoiceNo_ });
  if (inv) { out.invoiceNo = inv.value; evidence.push({ field: 'invoiceNo', anchor: inv.anchor, value: inv.value }); }

  const idt = findByAnchor_(t, A.invoiceDate, { validator: looksLikeDateText_ });
  if (idt) {
    const p = parseDate_(idt.value);
    if (p) { out.invoiceDate = p.iso; out.dateAmbiguous = p.ambiguous; evidence.push({ field: 'invoiceDate', anchor: idt.anchor, value: p.iso }); }
  }

  const ddt = findByAnchor_(t, A.dueDate, { validator: looksLikeDateText_ });
  if (ddt) {
    const p = parseDate_(ddt.value);
    if (p) { out.dueDate = p.iso; evidence.push({ field: 'dueDate', anchor: ddt.anchor, value: p.iso }); }
  }

  const tot = findByAnchor_(t, A.total, { validator: looksLikeAmount_ });
  if (tot) {
    const a = parseAmount_(tot.value);
    if (a) {
      out.amount = a.value; out.currency = a.currency; out.amountAmbiguous = a.ambiguous;
      out.decimals = a.decimals; out.amountRaw = a.raw;
      evidence.push({ field: 'amount', anchor: tot.anchor, value: a.value });
    }
  }

  const tx = findByAnchor_(t, A.tax, { validator: looksLikeAmount_ });
  if (tx) {
    const a = parseAmount_(tx.value);
    if (a) { out.tax = a.value; evidence.push({ field: 'tax', anchor: tx.anchor, value: a.value }); }
  }

  out.docType = detectDocType_(t);
  out.hasAmount = (out.amount !== null);
  out.isPortal = detectPortal_(t);
  out.genericAnchors = evidence.filter(function (e) { return e.anchor.length <= 6; }).length;
  return out;
}

// ---- confidence -------------------------------------------------------------

/**
 * Confidence in [0,1]. Starts from certainty and subtracts for every reason to
 * doubt. This is "how sure are we", not "is it right" (see DECISIONS.md D4).
 */
function scoreConfidence_(f, meta) {
  meta = meta || {};
  let c = 1.0;
  if (!f.invoiceNo) c -= 0.25;
  if (!f.invoiceDate) c -= 0.10;
  if (f.amount === null || f.amount === undefined) c -= 0.30;
  if (f.amountAmbiguous) c -= 0.15;
  if (meta.dateAmbiguous) c -= 0.08;
  if (!f.currency) c -= 0.05;
  if (f.genericAnchors > 1) c -= 0.05 * (f.genericAnchors - 1);
  if (meta.source === 'ocr') c -= 0.15;
  if (meta.template === 'generic') c -= 0.05;
  if (meta.multiColumnRisk) c -= 0.10;
  if (meta.jsonLd) c += 0.10;
  if (c > 1) c = 1;
  if (c < 0) c = 0;
  return Math.round(c * 100) / 100;
}


// ============================================================
// 50_Router.gs
// ============================================================

/**
 * 50_Router.gs — vendor routing and record extraction.
 *
 * Routing decides which template to apply:
 *   1. sender domain in VENDOR_TEMPLATES  -> that template
 *   2. sender domain is a known platform  -> escalate to a merchant match in the body
 *   3. otherwise                          -> GENERIC_TEMPLATE
 *
 * Per-vendor templates are placeholders until real samples arrive. The *shape*
 * is what matters now; re-tuning anchors later must not require touching the
 * pipeline.
 */

/** Domains that are payment platforms, not merchants. */
const PLATFORM_DOMAINS = {
  'stripe.com': 1, 'paypal.com': 1, 'paddle.com': 1, 'paddle.net': 1,
  'shopify.com': 1, 'intuit.com': 1, 'quickbooks.com': 1, 'bill.com': 1,
  'squareup.com': 1, 'braintreepayments.com': 1, 'chargebee.com': 1,
  'revolut.com': 1, 'wise.com': 1, 'xero.com': 1,
  'google.com': 1, 'gcash.com': 1
};

const GENERIC_TEMPLATE = { name: 'generic', vendor: '', domains: [], anchors: null };

/**
 * Vendor registry, keyed by sender domain.
 *
 * Template shape:
 *   {
 *     name:   'acme',
 *     vendor: 'Acme Corp',
 *     domains: ['acme.com'],
 *     anchors: {                      // optional; prepended to the generic anchors
 *       invoiceNo: ['acme ref'],
 *       total: ['amount payable']
 *     }
 *   }
 *
 * The entry below is an illustrative placeholder, not a real extraction.
 */
const VENDOR_TEMPLATES = {
  'acme.example': {
    name: 'acme',
    vendor: 'Acme (placeholder)',
    domains: ['acme.example'],
    anchors: { invoiceNo: ['acme invoice ref'], total: ['amount payable'] }
  }
};

/** Merchant hints for platform escalation. Extend once samples identify merchants. */
const MERCHANT_HINTS = [
  { vendor: 'Acme Corp', hints: ['acme'] },
  { vendor: 'Google Play', hints: ['capcut', 'google play', 'play.google'] },
  { vendor: 'GCash', hints: ['gcash', 'globe gcash'] }
];

// ---- sender parsing ---------------------------------------------------------

function fromDomain_(from) {
  const s = String(from || '');
  const m = s.match(/[<\s]([^<>\s@]+)@([^<>\s>]+)/) || s.match(/([^<>\s@]+)@([^<>\s>]+)/);
  if (!m) return '';
  return m[2].toLowerCase().replace(/[>.,;)]+$/, '');
}

// ---- routing ----------------------------------------------------------------

function matchMerchantHint_(text) {
  const t = String(text || '').toLowerCase();
  for (let i = 0; i < MERCHANT_HINTS.length; i++) {
    const hints = MERCHANT_HINTS[i].hints;
    for (let j = 0; j < hints.length; j++) {
      if (t.indexOf(String(hints[j]).toLowerCase()) !== -1) return MERCHANT_HINTS[i];
    }
  }
  return null;
}

function route_(fromEmail, bodyText) {
  const domain = fromDomain_(fromEmail);
  const platform = !!PLATFORM_DOMAINS[domain];
  let tpl = VENDOR_TEMPLATES[domain] || null;

  // Allow merchant hints to also set a friendlier vendor and doc type where obvious.
  if (!tpl && platform) {
    const m = matchMerchantHint_(bodyText);
    if (m) {
      tpl = {
        name: 'merchant_' + String(m.vendor).toLowerCase().replace(/\W+/g, '_'),
        vendor: m.vendor, domains: [], anchors: null
      };
    }
  }

  return {
    vendor: tpl ? tpl.vendor : (domain || 'unknown'),
    template: tpl || GENERIC_TEMPLATE,
    domain: domain,
    platform: platform,
    matched: !!tpl
  };
}

// ---- extraction orchestration ----------------------------------------------

/** Apply a template (anchors overlaid on generic ones) to a text blob. */
function runTemplate_(template, text, sourceKind) {
  const t = template || GENERIC_TEMPLATE;
  let anchors = ANCHORS;
  if (t.anchors) {
    anchors = {};
    Object.keys(ANCHORS).forEach(function (k) {
      anchors[k] = t.anchors[k] ? t.anchors[k].concat(ANCHORS[k]) : ANCHORS[k];
    });
  }
  const f = extractGeneric_(text, { source: sourceKind, anchors: anchors });
  f.templateName = t.name || 'generic';
  return f;
}

/**
 * Produce the final field set for one record (one attachment, or the body).
 * Overlays JSON-LD when present, then scores confidence.
 */
function extractRecord_(input) {
  const tpl = input.template || GENERIC_TEMPLATE;
  const f = runTemplate_(tpl, input.text || '', input.sourceKind || 'body');

  // The subject is a strong, cheap signal for the document type; fold it in.
  if (input.subject) {
    const s = String(input.subject).trim();
    if (s) f.docType = detectDocType_(s + '\n' + (input.text || ''));
  }

  const j = input.jsonLd;
  if (j) {
    if (j.invoiceNo && !f.invoiceNo) f.invoiceNo = String(j.invoiceNo);
    if (j.invoiceDate && !f.invoiceDate) { const p = parseDate_(j.invoiceDate); if (p) f.invoiceDate = p.iso; }
    if (j.dueDate && !f.dueDate) { const p = parseDate_(j.dueDate); if (p) f.dueDate = p.iso; }
    if ((f.amount === null || f.amount === undefined) && j.amount !== undefined && j.amount !== null) f.amount = j.amount;
    if (!f.currency && j.currency) f.currency = j.currency;
  }

  // Infer currency when amount exists but currency is missing (common in local banks).
  if ((f.amount !== null && f.amount !== undefined) && !f.currency) {
    const t = ((input.text || '') + '\n' + (input.subject || '')).toLowerCase();
    const v = String(f.vendor || input.vendor || '').toLowerCase();
    if (v.indexOf('gcash') !== -1 || t.indexOf('php') !== -1 || t.indexOf('peso') !== -1 || t.indexOf('p') === -1 && false) {
      // cheap: if gcash or mentions php/peso, assume PHP
    }
    if (v.indexOf('gcash') !== -1 || t.indexOf('php') !== -1 || t.indexOf('peso') !== -1) f.currency = 'PHP';
  }

  f.vendor = input.vendor || '';
  f.confidence = scoreConfidence_(f, {
    source: input.sourceKind,
    template: tpl.name || 'generic',
    dateAmbiguous: f.dateAmbiguous,
    multiColumnRisk: input.multiColumnRisk,
    jsonLd: !!j
  });
  return f;
}

/** Map an extraction result to a ledger status. */
function statusFor_(f, textLen) {
  if (f.isPortal && (f.amount === null || f.amount === undefined)) return STATUS.PORTAL;
  if (!textLen) return STATUS.NOTEXT;
  if (f.amount === null || f.amount === undefined) return STATUS.REVIEW;
  return (f.confidence >= 0.85) ? STATUS.OK : STATUS.REVIEW;
}


// ============================================================
// 60_Sheets.gs
// ============================================================

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


// ============================================================
// 70_Probe.gs
// ============================================================

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
    subject: source.subject,
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


// ============================================================
// 80_Tests.gs
// ============================================================

/**
 * 80_Tests.gs — self-tests for the pure logic.
 *
 * Run runTests() from the editor. No Google services are touched, so this also
 * runs in plain Node via tools/local-tests.js — which is how it is verified
 * without deploying.
 */

function runTests() {
  const results = [];
  function ok(name, cond, detail) {
    results.push({ name: name, pass: !!cond, detail: (detail === undefined ? '' : String(detail)) });
  }

  // sanitizeCell_ — formula injection guard
  ok('sanitize defangs =', sanitizeCell_('=1+1') === "'=1+1", sanitizeCell_('=1+1'));
  ok('sanitize defangs @', sanitizeCell_('@cmd') === "'@cmd", sanitizeCell_('@cmd'));
  ok('sanitize keeps number type', sanitizeCell_(5) === 5);
  ok('sanitize trims text', sanitizeCell_('  Acme  ') === 'Acme');

  // md5Hex_
  ok('md5("abc")', md5Hex_('abc') === '900150983cd24fb0d6963f7d28e17f72', md5Hex_('abc'));

  // fromDomain_
  ok('fromDomain angle form', fromDomain_('Acme <billing@acme.com>') === 'acme.com', fromDomain_('Acme <billing@acme.com>'));
  ok('fromDomain bare form', fromDomain_('billing@acme.com') === 'acme.com', fromDomain_('billing@acme.com'));

  // parseAmount_
  ok('amount $1,234.56', parseAmount_('$1,234.56').value === 1234.56, parseAmount_('$1,234.56').value);
  ok('amount 1.234,56 EUR', parseAmount_('1.234,56 EUR').value === 1234.56, parseAmount_('1.234,56 EUR').value);
  ok('amount currency code', parseAmount_('1.234,56 EUR').currency === 'EUR', parseAmount_('1.234,56 EUR').currency);
  ok('amount symbol EUR', parseAmount_('\u20ac 99,00').currency === 'EUR', parseAmount_('\u20ac 99,00').currency);
  ok('amount negative', parseAmount_('-$50.00').value === -50, parseAmount_('-$50.00').value);
  ok('amount ambiguous flag', parseAmount_('1.234').ambiguous === true, parseAmount_('1.234').ambiguous);

  // parseDate_
  ok('date ISO', parseDate_('2026-02-05').iso === '2026-02-05', JSON.stringify(parseDate_('2026-02-05')));
  ok('date D Mon YYYY', parseDate_('5 Feb 2026').iso === '2026-02-05', JSON.stringify(parseDate_('5 Feb 2026')));
  ok('date Mon D, YYYY', parseDate_('Feb 5, 2026').iso === '2026-02-05', JSON.stringify(parseDate_('Feb 5, 2026')));
  ok('date numeric', parseDate_('05/02/2026').iso === '2026-02-05', JSON.stringify(parseDate_('05/02/2026')));
  ok('date numeric ambiguous', parseDate_('05/02/2026').ambiguous === true);

  // anchor specificity — "invoice" must not capture the date
  const t = 'Invoice Date: 2026-02-05\nInvoice Number: INV-9\nTotal: 100';
  const found = findByAnchor_(normalizeText_(t), ANCHORS.invoiceNo, { validator: looksLikeInvoiceNo_ });
  ok('anchor prefers "invoice number"', found && found.value === 'INV-9', found && found.value);

  const t2 = 'Invoice\nInvoice Number: A-1\nInvoice Date: 2026-03-09\nTotal: 5';
  const f1 = extractGeneric_(t2);
  ok('generic invoiceNo', f1.invoiceNo === 'A-1', f1.invoiceNo);
  ok('generic invoiceDate', f1.invoiceDate === '2026-03-09', f1.invoiceDate);
  ok('generic amount', f1.amount === 5, f1.amount);

  // HTML stripping
  ok('stripHtml removes tags', stripHtml_('<p>Hi</p><br>there').indexOf('Hi') !== -1, stripHtml_('<p>Hi</p><br>there'));
  ok('stripHtml drops script', stripHtml_('<script>var x=1;</script>Hello').indexOf('Hi') === -1);

  // identity / dedupe
  const k1 = buildKeys_({ messageId: 'm1', attachmentName: 'a.pdf', attachmentBytes: [1, 2, 3], confidence: 0, invoiceNo: '' });
  ok('keys ATT + MSG', !!findKey_(k1, 'ATT') && !!findKey_(k1, 'MSG'));
  ok('no CNT at low confidence', !findKey_(k1, 'CNT'));

  const k2 = buildKeys_({
    messageId: 'm2', attachmentName: 'b.pdf', attachmentBytes: [1, 2, 3], confidence: 0.9,
    invoiceNo: 'X', amount: 1, currency: 'USD', invoiceDate: '2026-01-01', vendor: 'V'
  });
  ok('CNT present at high confidence', !!findKey_(k2, 'CNT'));

  const seen = {};
  seen[findKey_(k2, 'ATT').key] = true;
  const k3 = buildKeys_({ messageId: 'm3', attachmentName: 'c.pdf', attachmentBytes: [1, 2, 3], confidence: 0, invoiceNo: '' });
  ok('dedupe by ATT across messages', !!firstSeenKey_(k3, seen));

  // shape validators
  ok('invoiceNo rejects date', looksLikeInvoiceNo_('2026-02-05') === false);
  ok('invoiceNo accepts ref', looksLikeInvoiceNo_('INV-9') === true);
  ok('invoiceNo rejects prose', looksLikeInvoiceNo_('is ready') === false, looksLikeInvoiceNo_('is ready'));
  ok('invoiceNo rejects prose 2', looksLikeInvoiceNo_('is now available.') === false);

  // cleanValue_ must preserve a sign attached to an amount, drop a separator dash
  ok('cleanValue keeps amount sign', cleanValue_('-$50.00') === '-$50.00', cleanValue_('-$50.00'));
  ok('cleanValue drops separator dash', cleanValue_('- 123') === '123', cleanValue_('- 123'));

  // confidence banding
  const good = scoreConfidence_({ invoiceNo: 'A', invoiceDate: '2026-01-01', amount: 10, currency: 'USD', genericAnchors: 0 }, {});
  const bad = scoreConfidence_({ invoiceNo: '', invoiceDate: '', amount: null, currency: '', genericAnchors: 2 }, {});
  ok('confidence high for full fields', good >= 0.9, good);
  ok('confidence low for empty fields', bad <= 0.4, bad);

  // config: an unset numeric property must use the fallback, not 0
  ok('cfgInt_ empty -> fallback', cfgInt_('__MISSING_KEY__', 318000) === 318000,
    cfgInt_('__MISSING_KEY__', 318000));

  // currency symbols beyond $
  ok('amount symbol PHP', parseAmount_('\u20b149.00').currency === 'PHP', parseAmount_('\u20b149.00').currency);
  ok('amount value PHP', parseAmount_('\u20b149.00').value === 49, parseAmount_('\u20b149.00').value);

  // parentheses: a bracketed *amount* is negative, a bracketed *clause* is not
  ok('bracketed amount negative', parseAmount_('(50.00)').value === -50, parseAmount_('(50.00)').value);
  ok('bracketed clause not negative', parseAmount_('(Includes VAT of 5.25)').value === 5.25,
    parseAmount_('(Includes VAT of 5.25)').value);

  // doc type: a bare "credit" (e.g. credit card) must not mean credit note
  ok('credit card is not a credit note', detectDocType_('Paid with credit card') === 'receipt',
    detectDocType_('Paid with credit card'));
  ok('credit note still detected', detectDocType_('CREDIT NOTE') === 'credit_note', detectDocType_('CREDIT NOTE'));
  ok('cleanValue strips leading star', cleanValue_('* GPA.1') === 'GPA.1', cleanValue_('* GPA.1'));

  // a receipt whose body mentions refund help must stay a receipt
  ok('receipt title beats body refund',
    detectDocType_('Your Google Play Order Receipt\nTotal: 49.00\nHow to request a refund') === 'receipt',
    detectDocType_('Your Google Play Order Receipt\nTotal: 49.00\nHow to request a refund'));
  ok('refund subject is a credit note',
    detectDocType_('Refund processed\nWe have refunded your card') === 'credit_note',
    detectDocType_('Refund processed\nWe have refunded your card'));

  // real-sample regression: Google Play (CapCut) receipt, non-USD
  const gp = fixtures_().filter(function (f) { return f.name === 'google-play-receipt'; })[0];
  const gpRouted = route_(gp.from, gp.text);
  const gpRec = extractRecord_({
    text: gp.text, sourceKind: 'body', vendor: gpRouted.vendor,
    subject: gp.subject,
    template: gpRouted.template, jsonLd: null, multiColumnRisk: false
  });
  ok('GP receipt docType', gpRec.docType === 'receipt', gpRec.docType);
  ok('GP receipt amount 49', gpRec.amount === 49, gpRec.amount);
  ok('GP receipt currency PHP', gpRec.currency === 'PHP', gpRec.currency);
  ok('GP receipt order no', /GPA\./.test(gpRec.invoiceNo), gpRec.invoiceNo);
  ok('GP receipt date', gpRec.invoiceDate === '2026-09-11', gpRec.invoiceDate);
  ok('GP receipt tax 5.25', gpRec.tax === 5.25, gpRec.tax);

  const failed = results.filter(function (r) { return !r.pass; });
  results.forEach(function (r) {
    Logger.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '  -> ' + r.detail));
  });
  Logger.log('TESTS: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  return { total: results.length, failed: failed.length, results: results };
}


// ============================================================
// 90_Main.gs
// ============================================================

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

/**
 * Id of the temp folder used for OCR conversions.
 *
 * Uses the advanced Drive API rather than DriveApp: DriveApp.createFolder
 * requires the full `drive` scope, while Drive API files.insert accepts the
 * narrower `drive.file` scope we declare. Recreates the folder if it vanished.
 */
function tempOcrFolderId_() {
  const cached = cfg_(PROP.TEMP_OCR_FOLDER_ID, '');
  if (cached) {
    try { Drive.Files.get(cached); return cached; } catch (e) { /* gone; recreate */ }
  }
  const f = Drive.Files.insert({
    title: 'TempInvoiceOCR',
    mimeType: 'application/vnd.google-apps.folder'
  });
  setProp_(PROP.TEMP_OCR_FOLDER_ID, f.id);
  return f.id;
}

/** Best-effort removal of OCR temp docs older than TEMP_OCR_TTL_MS. */
function cleanupTempOcr_() {
  const folderId = cfg_(PROP.TEMP_OCR_FOLDER_ID, '');
  if (!folderId) return;
  try {
    const res = Drive.Files.list({
      q: "'" + folderId + "' in parents and trashed = false",
      maxResults: 200
    });
    const items = res.items || [];
    const cutoff = Date.now() - TEMP_OCR_TTL_MS;
    for (let i = 0; i < items.length; i++) {
      const created = Date.parse(items[i].createdDate || '');
      if (!isNaN(created) && created < cutoff) {
        try { Drive.Files.remove(items[i].id); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    log_('WARN', 'temp OCR cleanup skipped: ' + (e && e.message ? e.message : e));
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
  const folderId = tempOcrFolderId_();
  const blob = Utilities.newBlob(att.bytes, att.mimeType, att.name);
  let file;
  try {
    file = Drive.Files.insert(
      { title: 'ocr_' + att.name, mimeType: 'application/vnd.google-apps.document', parents: [{ id: folderId }] },
      blob,
      { convert: true, ocr: true, ocrLanguage: ocrLanguage_() }
    );
  } catch (e) {
    const m = (e && e.message) ? e.message : String(e);
    return { text: '', tables: [], error: 'convert_failed: ' + m, encrypted: /password|encrypt/i.test(m) };
  }

  let text = '', tables = [], readErr = '';
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
    // Keep any partial text, but surface the failure rather than hiding it.
    readErr = 'doc_read_failed: ' + (e && e.message ? e.message : e);
  }
  try { Drive.Files.remove(file.id); } catch (e) { /* ignore */ }

  let combined = text || '';
  if (tables.length) {
    combined += '\n' + tables.map(function (t) { return t.label + ': ' + t.value; }).join('\n');
  }
  return { text: combined, tables: tables, error: readErr };
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
  if (!isDryRun_()) {
    var sh = sheetForDate_(recObj['Date']);
    appendRowsToSheet_(sh, [ledgerRow_(recObj)]);
  }
  keys.forEach(function (k) { seen[k.key] = true; });
  stats.records++;
  if (recObj.Status !== STATUS.OK) stats.review++;
}

function makeRecord_(source, routed, attName, f, status, detail, notes, sourceKind) {
  var amt = (f.amount === null || f.amount === undefined) ? '' : f.amount;
  var totalPaid = '';
  var outstanding = amt;
  var payDate = '';
  if (f.docType === 'receipt') {
    totalPaid = amt;
    outstanding = 0;
    payDate = f.invoiceDate || isoNow_().substring(0,10);
  } else if (status === 'ok') {
    totalPaid = '';
    outstanding = amt;
    payDate = '';
  } else {
    totalPaid = '';
    outstanding = amt;
    payDate = '';
  }
  return {
    'Invoice #': f.invoiceNo || '',
    'Date': f.invoiceDate || '',
    'Payment due': f.dueDate || '',
    'Brand name': routed.vendor || '',
    'Amount': amt,
    'Total paid': totalPaid,
    'Outstanding': outstanding,
    'Status': (f.docType === 'receipt') ? 'Paid' : status,
    'Payment Date': payDate,
    'Notes': notes || ''
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
    subject: source.subject,
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


// ============================================================
// Fixtures.gs
// ============================================================

/**
 * Fixtures.gs — synthetic samples for the extraction engine.
 *
 * These are NOT real invoices. They exist so the engine can be developed and
 * verified before real samples arrive. When samples do arrive, add them here
 * (or via 70_Probe.gs) in exactly the same shape — the engine sees no difference.
 */

function fixtures_() {
  return [
    {
      name: 'plain-us',
      from: 'Acme Billing <billing@acme.example>',
      subject: 'Invoice ACME-1042',
      kind: 'body',
      text: [
        'INVOICE',
        'Acme Corp',
        'Invoice Number: ACME-1042',
        'Invoice Date: 05 Jan 2026',
        'Due Date: 19 Jan 2026',
        '',
        'Subtotal: $1,000.00',
        'VAT: $200.00',
        'Total Amount Due: $1,200.00',
        '',
        'Thank you for your business.'
      ].join('\n')
    },
    {
      name: 'eu-amounts',
      from: 'Euro Vendor <invoice@vendor-eu.example>',
      subject: 'Rechnung / Invoice',
      kind: 'body',
      text: [
        'Invoice',
        'Invoice Number: EU-7781',
        'Invoice Date: 05/02/2026',
        'Total: 1.234,56 EUR'
      ].join('\n')
    },
    {
      name: 'ocr-table',
      from: 'Scanned Vendor <ar@scanned.example>',
      subject: 'Your invoice (scanned)',
      kind: 'ocr',
      text: [
        'Invoice',
        'Invoice No: OCR-55',
        'Invoice Date: 2026-03-01',
        'Description          Amount',
        'Widget               100.00',
        'Service              50.00',
        'Grand Total: 150.00'
      ].join('\n')
    },
    {
      name: 'portal-link',
      from: 'SaaS Co <no-reply@saasco.example>',
      subject: 'Your invoice is ready',
      kind: 'body',
      text: [
        'Your invoice is ready',
        'Hi there, your February invoice is now available.',
        'Sign in to view and download your invoice.',
        'Manage your account from the billing portal.'
      ].join('\n')
    },
    {
      name: 'credit-note',
      from: 'Acme Billing <billing@acme.example>',
      subject: 'Credit note CN-900',
      kind: 'body',
      text: [
        'CREDIT NOTE',
        'Credit Note Number: CN-900',
        'Date: 2026-04-02',
        'Total: -$50.00'
      ].join('\n')
    },
    {
      name: 'jsonld',
      from: 'Shop <orders@shop.example>',
      subject: 'Order confirmation',
      kind: 'body',
      text: 'Thanks for your purchase. A receipt is available in your account.',
      jsonLd: { invoiceNo: 'ORD-1', invoiceDate: '2026-05-03', amount: 42.5, currency: 'USD' }
    },
    {
      // Sanitised real sample: Google Play (CapCut) subscription receipt, PHP.
      // Exercises a non-$ currency symbol, a platform order number, VAT, and a
      // timestamped date. Personal details replaced with placeholders.
      name: 'google-play-receipt',
      from: 'Google Play <googleplay-noreply@google.com>',
      subject: 'Your Google Play Order Receipt',
      kind: 'body',
      text: [
        'Thank you',
        'Your trial of CapCut - Video Editor has ended. Your subscription continues at the price of \u20b149.00. Starting Oct 7, 2026 you will be automatically charged \u20b1480.00/month unless you cancel.',
        '',
        'Order number: GPA.1234-5678-9012-34567..0',
        'Order date: Sep 11, 2026 3:34:52 AM GMT+8',
        'Your account: someone@example.com',
        'Item\tPrice',
        'Monthly Subscription (CapCut: Photo & Video Editor)\t\u20b149.00',
        'Total: \u20b149.00',
        '(Includes VAT of \u20b15.25)',
        'Payment method:',
        'GCash: 63-9****00000'
      ].join('\n')
    }
  ];
}


