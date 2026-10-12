# Invoice Tracker (Gmail → Google Sheets)

A personal, $0-budget pipeline that watches a Gmail label, extracts invoice /
receipt fields, and appends rows to a Google Sheet. Built as a Google Apps
Script project.

> **Status:** scaffold + tested extraction core. Per-vendor template tuning is
> deferred until real sample invoices are provided (see `DECISIONS.md`).

---

## What works today

- **Detection** via a Gmail label + `Gmail.Users.History.list(..., labelId,
  historyTypes:['labelAdded'])`, so discovery stays server-side filtered.
- **Two-phase sync**: cheap discovery into a `PendingQueue` sheet, then
  processing. A hard 6-minute kill can only defer work, never lose it.
- **Bootstrap** captures `H0 = getProfile().historyId` *before* backfilling, so
  mail that arrives mid-backfill is still covered.
- **404 history-gap recovery** with an alert.
- **Layered identity / dedupe**: `ATT` (md5 of attachment bytes), `MSG`
  (messageId+attachment), `CNT` (gated content hash).
- **Extraction engine** (pure, unit-tested): anchors, HTML→text, JSON-LD,
  amount parsing (US + EU separators), date parsing (ISO / `D Mon YYYY` /
  numeric with ambiguity flag), doc-type and portal detection.
- **Confidence scoring** and status bucketing (`ok`, `needs_review`,
  `portal_manual`, `needs_review_encrypted`, `needs_review_no_content`).
- **OCR path** for PDF/image attachments via Drive → Google Doc conversion,
  including table extraction to avoid column-scramble.
- **Probe mode** (read-only) for inspecting real samples.
- **Formula-injection sanitisation** on every cell written.

## What is deliberately deferred

- Real vendor templates (waiting on samples).
- Acceptance thresholds (D3) and ground-truth validation (D4).
- Whether platform senders (Stripe/PayPal/…) need per-merchant routing (D5).

---

## Project layout

| File | Purpose |
| --- | --- |
| `appsscript.json` | Manifest: V8, advanced Gmail v1 + Drive v2 services, scopes. |
| `00_Config.gs` | Script Properties accessors, sheet schema, constants. |
| `10_Lib.gs` | md5, cell sanitising, retry/backoff, run clock, logging, alerting. |
| `20_Identity.gs` | Layered dedupe keys + KeyIndex rows. |
| `30_Sync.gs` | Label resolution, history polling, backfill, gap recovery, queue. |
| `40_Extract.gs` | Pure extraction engine (anchors, amounts, dates, JSON-LD). |
| `50_Router.gs` | Sender→template routing, record extraction, status mapping. |
| `60_Sheets.gs` | Spreadsheet/schema bootstrap, batched writes, queue helpers. |
| `70_Probe.gs` | Read-only inspection entry points. |
| `80_Tests.gs` | Self-tests for the pure logic. |
| `90_Main.gs` | Pipeline orchestration, `run()`, `setup()`, triggers. |
| `Fixtures.gs` | Synthetic sample sources. |
| `tools/local-tests.js` | Runs the pure logic + fixtures under Node. |

---

## Setup

1. **Create the Apps Script project**
   - Go to <https://script.google.com> → *New project*.
   - Replace the default files with the `.gs` files here (or use `clasp`).
   - Set the manifest: *Project Settings → Show "appsscript.json"*, then paste
     `appsscript.json`.
   - **Change `timeZone`** from `Etc/UTC` to your real zone.

2. **Enable advanced services**
   - *Editor → Services → +* → add **Gmail API** (v1) and **Drive API** (v2).
   - Drive v2 is used because it exposes `ocr: true` on insert.

3. **Script Properties** (*Project Settings → Script Properties*), all optional:
   - `INVOICE_LABEL` — label name (default `InvoiceTracker`).
   - `DRY_RUN` — `true` (default) writes nothing to the ledger; set `false` to
     go live.
   - `OCR_LANGUAGE` — default `en`.

4. **Create the Gmail filter**
   - In Gmail, create a filter that applies the label (e.g. from known
     senders, or `has:attachment filename:pdf`). Keep it deliberately broad —
     a missed label is an invisible gap.

5. **Run `setup()`** from the editor.
   - Creates the spreadsheet + tabs, resolves/creates the label, prints the
     spreadsheet ID.

6. **Dry run**: leave `DRY_RUN=true`, run `run()`, and check execution logs.

7. **Go live**: set `DRY_RUN=false`, then run `installTrigger()` once to add an
   hourly trigger.

---

## Testing (and testing real samples later)

### Offline (no deployment)
```bash
node tools/local-tests.js
```
Runs the unit tests and the synthetic fixtures through the real engine. Current
result: **36/36 passing**.

Fixtures cover: plain text, EU number formats, OCR-style tables, portal-link
emails, credit notes, and JSON-LD.

### In Apps Script (read-only)
- `runTests()` — same assertions, in-editor.
- `probeFixtures()` — fixture report.
- `probeLabel(n)` — extracts every message under the label, **no writes**.
- `probeText(subject, fromText, body)` — ad-hoc paste.
- `probeDriveFile(fileId)` — runs a PDF/image through the real OCR path.

### When real samples arrive
1. Drop them through `probeLabel()` (label them in Gmail) or `probeText()`.
2. Add a fixture in `Fixtures.gs` with the same `{name, from, subject, kind,
   text, jsonLd}` shape so the case becomes a permanent regression test.
3. Only then tune anchors/templates in `50_Router.gs` (`VENDOR_TEMPLATES`).

The engine takes a plain **source object** — `{ messageId, from, subject,
bodyText, html, jsonLd, attachments }`. `buildSource_()` is the only adapter
from Gmail, and fixtures/probes use the identical shape. That seam is what
makes real samples testable without touching the pipeline.

---

## Safety notes

- **Financial data**: prefer visible uncertainty over silent corruption. Anything
  that fails a shape check is dropped or flagged, never guessed.
- **Dedupe bias**: a duplicate is visible; a dropped invoice is silent. The weak
  `CNT` key is gated on high confidence.
- **Formula injection**: `sanitizeCell_()` prefixes any `= + - @` cell with `'`.
- **Scope**: `https://mail.google.com/` is required by `GmailApp`. The project
  must not be shared. Enabling the advanced Drive service can widen the Drive
  scope beyond `drive.file` — verify in the consent screen and accept or drop
  the OCR path accordingly.
- **Quotas** (consumer Gmail): triggers total ~90 min/day; 6 min/execution.
  The run clock defaults to 5.3 min and stops cleanly.

---

## References

Design rationale and research live alongside the code:
`RESEARCH.md`, `DECISIONS.md`, `SOLUTIONS.md`, `RISKS.md`,
`VENDOR-TEMPLATES.md`, `REFERENCES.md`.
