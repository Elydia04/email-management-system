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
  'Timestamp', 'MessageId', 'AttachmentName', 'Vendor', 'DocType',
  'InvoiceNo', 'InvoiceDate', 'DueDate', 'Amount', 'Currency',
  'Tax', 'Status', 'Confidence', 'Source', 'SourceDetail',
  'DedupeKey', 'Notes', 'From', 'Subject'
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
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function setProp_(key, value) { props_().setProperty(key, String(value)); }
function delProp_(key) { props_().deleteProperty(key); }

function isDryRun_() { return String(cfg_(PROP.DRY_RUN, DEFAULTS.DRY_RUN)).toLowerCase() === 'true'; }
function maxExecutionMs_() { return cfgInt_(PROP.MAX_EXECUTION_MS, Number(DEFAULTS.MAX_EXECUTION_MS)); }
function invoiceLabelName_() { return cfg_(PROP.INVOICE_LABEL, DEFAULTS.INVOICE_LABEL); }
function ocrLanguage_() { return cfg_(PROP.OCR_LANGUAGE, DEFAULTS.OCR_LANGUAGE); }
