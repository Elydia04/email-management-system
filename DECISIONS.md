# Decisions & Open Items

Running log. Decided items are binding for the build; open items need resolution before or during it.

---

## Decided

### D1 — Detection mechanism: Gmail filter label, polled via history
A Gmail filter labels candidate invoice mail **at delivery**; the script discovers work by polling
Gmail history for that label. Detection is therefore done by Gmail itself (free, reliable, no quota),
and the script only does extraction.

**Discovery call:**
```js
Gmail.Users.History.list('me', {
  startHistoryId: cursor,
  labelId: INVOICE_LABEL_ID,
  historyTypes: ['labelAdded']
});
```

**Why this is better than the alternatives**
- **Server-side filtered**, so we don't enqueue every piece of new mail (my original worry about
  `history.list` having no query filter is resolved — it has `labelId` + `historyTypes`).
- **The fallback gets simpler too.** On a 404 full-sync, the recovery search is just
  `GmailApp.search('label:<InvoiceLabel> ...')` — the label *is* the candidate set, so we no longer
  need broad `newer_than:` invoice guesswork.
- **Bootstrap gets simpler.** A Gmail filter can be created with "Also apply to matching
  conversations", which retro-labels existing mail. That seeds history cleanly.

**Verified API facts (from the Gmail reference)**
- `labelId`: "Only return messages with a label matching the ID."
- `historyTypes[]`: `messageAdded` | `messageDeleted` | `labelAdded` | `labelRemoved`.
- `maxResults` defaults 100, max 500.
- `startHistoryId` is "typically valid for at least a week, but in rare circumstances may be valid for
  only a few hours"; invalid/expired ⇒ HTTP 404 ⇒ perform a full sync.
- No `nextPageToken` ⇒ store the returned `historyId` for the next request.

**Setup (one-time)** — a dedicated label (e.g. `InvoiceTracker`) plus a filter whose criteria are
deliberately *broad* (coarse gate; fine extraction stays with the vendor templates). Optionally the
script can create both via `Gmail.Users.Settings.Filters` + `Users.Labels`, or the user can do it in the
Gmail UI.

**New risk introduced by this choice**
If the filter criteria are too narrow, invoices are **never labeled → invisible gaps** with no error.
Mitigations: keep the filter broad; monitor labeled-mail volume; the `Vendors` drift view should include
"labeled mail that routed to generic/needs-review".

### D2 — Scope: accept the broad mail scope
`GmailApp` requires `https://mail.google.com/` (read, write, and permanently delete all mail). We accept
it. It is a personal, single-account tool, and a read-only path (`gmail.readonly`) is likely not
achievable inside Apps Script.

**Guardrails that come with accepting it**
- The script project is **not shared**; it stays tied to the one account.
- Code is versioned in git so any change is reviewable.
- All *other* scopes are held to the minimum: `spreadsheets`, `drive.file`, `script.scriptapp`.
- The design is **non-destructive by construction**: it never deletes, moves, or modifies mail. The
  broad scope is required by the API, not by the design.
- The consent screen will use alarming wording ("permanently delete all your email"). That is the
  API's phrasing, not a capability we use.

---

## Open / deferred

### D3 — Acceptance target: deferred
What accuracy counts as "good enough," and what happens when it isn't. Decision deferred to the testing
phase — we'll determine it empirically once real extraction is running.

### D4 — Validation / ground truth: deferred, pending sample invoices
Currently we can flag *uncertainty* (confidence) but cannot *verify correctness*. Options under
consideration for later: none / periodic manual spot-check / reconciliation against a statement.
Wait for sample invoices.

### D5 — Domain questions still unanswered
- Roughly how many partnered brands?
- Do any arrive via platform domains (Stripe / PayPal / Paddle / Shopify / Intuit)?
- Do brands send multiple doc types (invoice vs credit note vs receipt)?
- Approximate volume per month?

---

## Blocked
Per-vendor template tuning — waiting on sample invoices.

---

## Next step
Scaffold the **sample-independent** parts: `lib` (md5, sanitize, retry, time guard, logging, lock),
`identity` (layered keys + KeyIndex), `sync` (history discovery via the label + pending queue +
bootstrap + 404 recovery), plus the extraction engine and a `PROBE` mode driven by synthetic fixtures.
Per-vendor templates follow once samples land.
