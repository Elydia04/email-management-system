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

function isoNow_() { return new Date().toISOString(); }

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
