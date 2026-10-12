# Vendor-Template Extraction Design

Companion to `RESEARCH.md`. Focus: invoices come from a **small set of partnered brands**, so we route
by vendor and apply a known template instead of one generic regex.

---

## 1. The core idea: a vendor registry

```
email  ──▶  identify sender/vendor  ──▶  look up template  ──▶  apply field rules  ──▶  normalize
                     │                         │
                (registry)                (source hint + patterns)
```

A **template** answers three questions for one brand:
1. **Where** is the data? (email body, PDF attachment, or image/OCR)
2. **What** are the field patterns/anchors?
3. **How** should the values be normalized (currency, date format)?

Unknown senders fall back to a generic extractor and are flagged `Needs review`.

---

## 2. Routing: identifying the vendor

**Primary key = sender domain** (from the `From:` header), not the display name.

```
From: "Acme Billing" <billing@mail.acme.com>
      └ display name   └ domain = mail.acme.com
```

Rules:
- Extract with `/([^@<\s]+)@([^>\s]+)/`, take the domain, lowercase it.
- Keep **both** the exact domain (`mail.acme.com`) and the **root domain** (`acme.com`) as match keys.
- Regional domains differ: `amazon.com` vs `amazon.co.uk` — treat as separate keys or map to one vendor.

### ⚠️ The third-party platform problem
Many partnered brands do **not** send from their own domain. Their invoices arrive via billing
platforms, where the domain only tells you the *platform*, not the merchant:

| Domain | Actual merchant is... |
|---|---|
| `stripe.com` | whoever the Stripe account belongs to |
| `paypal.com` | payee |
| `paddle.com` | SaaS vendor |
| `shopify.com` | store |
| `intuit.com` / `quickbooks` | small vendor |

For these, the domain alone is **not enough**. Add a **secondary discriminator**:
- merchant/company name in the body (`Sold by: ...`, `Merchant: ...`),
- subject line,
- or the platform + amount.

Keep a `platformDomains` set; when the sender is a platform, escalate to a body-based match.

### Fallback chain for routing
1. exact domain → template
2. root domain → template
3. platform domain → merchant-name match → template
4. subject/attachment-name pattern
5. generic extractor + `Needs review`

---

## 3. Template anatomy

Templates live in code (a JS array) — no quota cost, versioned with the project. The editable
per-vendor metadata (enabled, notes, success stats) can live in a `Vendors` sheet tab.

```js
const TEMPLATES = [
  {
    id: 'acme',
    vendor: 'Acme Corporation',
    match: {
      domains: ['acme.com', 'mail.acme.com'],
      subjectIncludes: ['invoice'],        // optional narrowing
    },
    source: 'pdf',                          // 'body' | 'pdf' | 'image' | 'auto'
    attachment: /invoice.*\.pdf$/i,         // which attachment to read
    currency: 'USD',                        // expected, used for validation
    fields: {
      invoiceNo:  { anchors: ['invoice number', 'invoice no', 'invoice #'], value: /([A-Z0-9][A-Z0-9\-\/]{3,})/i },
      invoiceDate:{ anchors: ['invoice date', 'date issued'],              value: dateRegex },
      amount:     { anchors: ['grand total', 'amount due', 'total due'],   value: moneyRegex },
      dueDate:    { anchors: ['due date', 'payment due'],                  value: dateRegex },
    },
  },
  // ...
];
```

A brand with multiple layouts (invoice vs credit note) gets **sub-variants** selected by
subject or attachment name.

---

## 4. Extraction techniques, ranked by robustness

Apply in this order, stop at the first confident hit:

1. **Anchor/label-based (best).** Find the label ("Invoice Number"), capture the value beside or just
   below it. This survives layout shuffles, reordering, and most template changes. Preferred whenever
   the doc has labels.
2. **Named pattern with vendor literal.** Regex tuned to the brand's known format.
3. **Table/repeating-line parsing.** Parse line items; use the sum as a *cross-check* on the total.
4. **Positional/fixed-offset.** Only for a layout you personally control. Brittle — avoid for vendor mail.
5. **Generic fallback.** Run the union of all anchors/patterns across the whole text; low confidence.

Helper sketch:

```js
function findByAnchor(text, anchors, valueRe, lookahead = 2) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    for (const a of anchors) {
      const idx = low.indexOf(a);
      if (idx < 0) continue;
      // same line, to the right of the label
      let m = lines[i].slice(idx + a.length).match(valueRe);
      if (m) return m[1] ?? m[0];
      // next few lines (Docs/OCR often puts value on the following line)
      for (let j = 1; j <= lookahead; j++) {
        m = (lines[i + j] || '').match(valueRe);
        if (m) return m[1] ?? m[0];
      }
    }
  }
  return null;
}
```

Shared value patterns:
```js
const moneyRegex = /([$€£₱]?\s?\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{2}))/;
const dateRegex  = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/;
```

Note: Google Docs text (from PDF/OCR conversion) is roughly in reading order, so "Label / Value" often
appear as consecutive lines — hence the multi-line lookahead.

---

## 5. Confidence and validation

Score each record; only trust high scores.

| Check | Weight |
|---|---|
| Amount matched and `> 0` | required |
| Date matched and parses | required |
| invoiceNo matched | bonus |
| Sum of line items ≈ total (if available) | strong bonus |
| Currency matches template expectation | bonus |
| Source is body/PDF (not OCR) | bonus |

- **All required + good bonuses** → `Auto`, write to main tab.
- **Partial, or OCR-sourced, or unknown vendor** → `Needs review`.
- **Required field missing** → do not write; log it.

**Normalization layer** (where "no errors" is actually won):
- Amount → `Number` (strip thousands separators; handle `1.234,56` vs `1,234.56`).
- Date → ISO `YYYY-MM-DD` **and** keep the raw string.
- Currency → ISO code from symbol.
- Vendor → canonical name from the registry.
Never store a raw parse without its normalized twin.

---

## 6. Drift detection (vendors change their invoices)

Track per-vendor **success rate over recent invoices**. If a vendor that used to score 3/3 suddenly
drops to 1/3 several times in a row, its layout probably changed.

- Keep rolling stats in a `VendorStats` tab (or `PropertiesService`).
- When a vendor's success rate falls below a threshold → raise a `Template drift` flag in the run log
  and route that vendor's rows to `Needs review` until re-tuned.
- This turns "silent wrong numbers" into "visible, fixable" — the whole point.

---

## 7. Onboarding a new brand (repeatable workflow)

1. Collect 2–3 samples from the brand.
2. Run **PROBE mode** (a helper function) on one message id → dumps:
   - routing decision (which domain/platform matched),
   - the raw text of body/PDF/OCR,
   - candidate matches for every field.
3. Pick stable anchors from the dumped text.
4. Write the template object; run it against the other samples to confirm.
5. Register the vendor in the `Vendors` tab.

PROBE mode is the productivity multiplier — it means you never write a template blind.

---

## 8. Where to store what

| Thing | Where | Why |
|---|---|---|
| Field rules / anchors | code (`TEMPLATES`) | versioned, free, no quota |
| Vendor list, enabled flag, notes | `Vendors` sheet tab | edit without redeploy |
| Per-vendor success stats | `VendorStats` tab / Properties | drift detection |
| Processed dedupe keys | main sheet | idempotency |

Trade-off: sheet-based rules are editable but cost reads and are easy to break; code-based rules are
safer. For a small partner set, keep **rules in code**, **metadata in the sheet**.

---

## 9. Building without samples

We can start before real invoices arrive:
- Implement the **engine + anchor helper + normalization**.
- Write the **generic fallback** template.
- Unit-test with **synthetic fixtures** (hand-written fake invoice text for a couple of layouts).
- Add **PROBE mode** so that when real mail is available, refining templates is fast.

Then when samples exist, we only add/`tune templates — no engine rewrite.

---

## 10. Open questions this raises

- How many partnered brands, roughly? (Sizes the template registry.)
- Do any arrive via platform domains (Stripe/PayPal/Paddle/etc.)? (Determines how much body-based
  routing is needed.)
- Do brands send multiple document types (invoice vs credit note vs receipt)?
