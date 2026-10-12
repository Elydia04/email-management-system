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
