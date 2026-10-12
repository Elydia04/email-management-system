# Risk & Loophole Audit

Adversarial review of the design in `RESEARCH.md` + `VENDOR-TEMPLATES.md`. Ordered by severity.
Each item: the loophole → why it bites → the fix.

---

## CRITICAL — these will bite if unhandled

### C1. Trigger frequency can exhaust the 90 min/day runtime quota
Consumer accounts get **90 min of *total trigger runtime* per day**. If we run every 15 min (96 runs)
and a run averages ~1 min, that's ~96 min → over quota. Then triggers start throwing exceptions and
**the automation silently stops** — the worst kind of failure.

**Fix:** start at 30–60 min intervals, make runs *early-exit* cheaply when there's nothing new, and
log per-run duration so we can see the daily burn. Revisit frequency only with data.

### C2. The dedupe store can't live where we assumed it would
`PropertiesService` total storage is **500 KB**. A dedupe key is ~40–60 bytes, so ~10k keys fills it,
and it grows forever. Storing keys *only* in the sheet is also fragile: if you ever edit or delete a
row, the key is lost and the invoice gets **reprocessed → duplicate**.

**Fix:** a dedicated, append-only **`ProcessedKeys`** store (its own sheet/tab) that is never hand-edited,
plus a second, content-based key so even that is recoverable (see H3). Load the key set **once** per run.

### C3. Hard timeout kills in-flight work
Apps Script **kills** execution at 6 minutes — it doesn't return gracefully. Anything not yet written
is lost.

**Fix:** adapt the `yahm0` pattern — a time guard (`MAX_EXECUTION_MS`) that *breaks cleanly*, saves a
checkpoint, and resumes next run; plus **batch-write atomically** so a crash mid-batch can't leave
half-rows. Dedupe must make reprocessing safe.

### C4. Formula / CSV injection from extracted text (security)
A vendor description, or a malicious email that spoofs a vendor, could contain a cell value starting
with `=`, `+`, `-`, or `@`. Sheets interprets it as a **formula** — e.g. `=IMPORTXML(...)` exfiltrating
data, or a `=HYPERLINK` phishing cell. We are piping untrusted email text straight into a sheet.

**Fix:** sanitize every string cell (prefix `'` or escape leading trigger chars), and validate types
(amount must be numeric, date must parse). Never trust extracted text.

### C5. Invoices that are inline images or HTML-only are missed
Our path looks at `getPlainBody()` + attachments. But:
- Some vendors put the invoice as an **inline image** in the HTML body (no attachment).
- Some HTML emails have **no plain-text part** → `getPlainBody()` returns empty.

**Fix:** detect and extract inline `<img>` sources from the HTML body; always fall back HTML→text
when plain is empty; log messages where *no* source yielded text.

### C6. Drive OCR scrambles multi-column layouts → wrong fields
Converting a PDF/image to a Google Doc flattens it to paragraphs. A **two-column "Label | Value"**
invoice can come out as jumbled text where the label and value are no longer adjacent — so anchor
lookup fails or grabs the wrong number.

**Fix:** when reading the converted Doc, also read **`DocumentApp` tables** cell-by-cell (label→value
pairs survive table structure better); validate every captured value against expected shape; route
OCR-sourced rows to `Needs review` by default.

### C7. "Your invoice is ready — log in" emails have no data
Many modern vendors stopped attaching invoices; they send a **portal link**. There is nothing to parse.
Our generic extractor will produce garbage or nothing.

**Fix:** detect this pattern (no attachment + body contains login/download phrasing) and route to a
separate **`Portal / manual`** bucket. Count them so the gap is visible, not silent.

---

## HIGH

### H1. Anchor substring collisions
An anchor `"invoice"` will match inside `"invoice date"` / `"invoice total"` and capture `Date` or a
total as the invoice number.

**Fix:** match **longest/most-specific label first**, require word boundaries, and validate the captured
value's *shape* (an invoice number must not look like a date or a currency amount). Keep an explicit
exclude list.

### H2. Amount & locale ambiguity
`1.234` is 1234 in EU formatting and 1.234 in US. `Total` appears as subtotal, tax total, grand total.
Some currencies have 0 decimals (JPY) or 3 (KWD/BHD).

**Fix:** resolve separator ambiguity by context (both separators present → unambiguous); prefer
`grand total`/`amount due` anchors over bare `total`; use a cross-check (sum of line items ≈ total)
when possible; store raw string **and** normalized number.

### H3. Vendor resends create duplicates
The same invoice emailed twice has a **different `messageId`** → passes the messageId dedupe → duplicate
row.

**Fix:** second-layer **content key** = hash of `(vendor + invoiceNo + amount + invoiceDate)` or an MD5 of
the attachment bytes (`Utilities.computeDigest`). Also make this the primary key for the `ProcessedKeys`
store so C2's fragility disappears.

### H4. Platform-domain routing (Stripe/PayPal/Paddle)
The sender domain is the *platform*, not the merchant → mis-attribution or generic fallback.

**Fix (already designed, must be built):** a `platformDomains` set that escalates to a body-based
merchant match.

### H5. Silent failure
A throwing trigger doesn't notify you. You'd discover a broken pipeline weeks later via missing data.

**Fix:** a `Log` tab + an alert email to yourself on error (mind the 100 recipients/day consumer limit),
and a heartbeat check (e.g. "no successful run in 24h → warn") — note the irony: the alerter must not
depend on the thing that's broken.

### H6. No retry/backoff for transient errors
Gmail/Drive/Sheets return `429`/`5xx` under load or quota pressure. A single one aborts the run.

**Fix:** exponential backoff wrapper (yahm0's `withRetry_` is a ready reference).

### H7. Password-protected / encrypted PDFs
Some invoices are password-protected → conversion fails → generic path produces nothing.

**Fix:** catch conversion failure distinctly and route to `Needs review` with a clear reason, rather
than logging a generic error.

### H8. Timezone misconfiguration
Project timezone affects `newer_than:`, date parsing, and `new Date()`. Wrong tz = off-by-a-day dates
and missed/duplicated windows.

**Fix:** pin the project timezone explicitly and store dates with an explicit tz.

### H9. Regex hazards
`/g` regex objects carry `lastIndex` state between uses (classic JS bug), and pathological patterns can
**catastrophically backtrack** on long OCR text → timeout (worse: mid-run).

**Fix:** no shared global-flagged regexes across calls; keep patterns linear; cap input length before
regex.

### H10. Orphaned temp docs
Every OCR conversion creates a Google Doc. A crash mid-way leaves them → Drive clutter and wasted quota.

**Fix:** create temp docs in one **dedicated temp folder** and clean it at the start of each run.

### H11. Thread-level "processed" marking is too coarse
A thread can hold several messages (reminder + invoice). Labeling the whole thread processed can skip
an unprocessed message (or vice versa).

**Fix:** track state per **message + attachment**, not per thread; treat labels as cosmetic only.

### H12. Vendor drift includes *routing*, not just fields
We designed drift detection for field failures. Vendors also change **sending domains** and **formats**
quarterly → routing silently falls to generic/miss.

**Fix:** track a "routed to specific template?" hit-rate per sender domain too; alert on drop.

---

## MEDIUM

- **M1. Sheet scan growth.** Loading all existing rows every run is O(n) and eventually slow. Load the
  dedupe set once, keep it in a compact store, or use `CacheService` (but cache has size caps and ~6h
  expiry → not durable).
- **M2. `appendRow` per row is slow.** Batch with one `getRange().setValues()` + `LockService`.
- **M3. Scope minimization.** Enabling the Drive advanced service adds scopes; request the narrowest set
  (Gmail read, Sheets, Drive file). Avoid `mail.google.com` / full `drive`.
- **M4. PII exposure.** The sheet holds financial data; the log may hold raw invoice text. Set sheet
  sharing to private, and don't dump raw text into the main tab.
- **M5. Execution history is short-lived.** Apps Script logs expire in days → the Log tab is the real
  audit trail.
- **M6. Trigger limits.** 20 triggers/script, 30 concurrent/user — fine for us, but don't spawn a trigger
  per vendor.
- **M7. Attachment size/page budget.** A 50-page PDF can eat the whole run. Cap pages/size; defer big
  ones to a later run.
- **M8. Multiple invoices per email / per PDF.** Key on message+attachment; but one PDF with *two*
  invoices still yields one row → detect and flag.
- **M9. Zero/three-decimal currencies.** Don't assume cents.
- **M10. Credit notes / refunds.** Negative amounts and distinct doc types; a "total" template must not
  silently record a credit as a charge.
- **M11. `From:` parsing edge cases.** Multiple addresses, no display name, `"Last, First" <a@b.com>`.
- **M12. Display-name spoofing.** Trust the **domain**, not the display name.
- **M13. LLM/Gemini path breaks $0.** It needs an API key, has rate limits, sends invoice contents to a
  third party, and may bill. It's an upgrade, not a default.

---

## LOW / polish

- **L1. clasp setup friction** for a non-developer — provide a copy-paste route as an alternative.
- **L2. No real tests.** Apps Script is hard to test → keep logic in **pure functions** and add a
  `SelfTest` harness with fixture strings (qonto does this).
- **L3. Attribution.** MIT/Apache/BSD/CC0 references require a `NOTICE`/README credit.
- **L4. Naming/cleanup.** Canonical vendor names, consistent attachment file names in the archive.

---

## Hardening checklist (fold into the build)

- [ ] Time guard + checkpoint/resume; atomic batch writes
- [ ] Immutable `ProcessedKeys` store keyed on **content hash** (not just messageId)
- [ ] Two-layer dedupe (messageId+attachment AND content hash)
- [ ] Sanitize all string cells (formula injection); type-validate numeric/date
- [ ] Anchor longest-match + value-shape validation + exclude list
- [ ] Read converted Docs **including tables**
- [ ] Handle inline images + HTML-only bodies + no-body cases
- [ ] Route portal-link / password-protected / no-text mails to explicit buckets
- [ ] Platform-domain escalation for routing
- [ ] Drift detection for fields **and** routing
- [ ] Retry/backoff wrapper; regex hygiene; input length caps
- [ ] Timezone pinned; raw + normalized values stored
- [ ] Log tab + error alert; per-run duration logging
- [ ] Temp-Drive-doc cleanup
- [ ] Conservative trigger frequency (respect the 90 min/day budget)

---

## The single biggest structural risk

Every vendor template is a **maintenance promise**. If layouts drift and nobody re-tunes, the system
degrades into wrong-but-plausible numbers — the most dangerous outcome. The confidence score + drift
detection + `Needs review` routing aren't nice-to-haves; they are the mechanism that converts silent
corruption into visible, fixable backlog. Build them **first**, not last.
