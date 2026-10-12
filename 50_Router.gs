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
  'revolut.com': 1, 'wise.com': 1, 'xero.com': 1
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
  { vendor: 'Acme Corp', hints: ['acme'] }
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

  // Platform senders don't identify the merchant — escalate to a body match.
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
