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
    }
  ];
}
