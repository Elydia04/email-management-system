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

  const failed = results.filter(function (r) { return !r.pass; });
  results.forEach(function (r) {
    Logger.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '  -> ' + r.detail));
  });
  Logger.log('TESTS: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  return { total: results.length, failed: failed.length, results: results };
}
