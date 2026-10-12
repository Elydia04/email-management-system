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
