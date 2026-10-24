# Invoice Tracker (Gmail → Google Sheets)

Automatically extracts invoice and receipt data from your Gmail and organises it
into a Google Sheets spreadsheet — with a master **Ledger** tab and separate
**monthly tabs** (e.g. "October 2026"). Runs entirely inside your own Google
account. Free. No third-party services.

---

## Quick Start (no coding required)

### Step 1 — Create an Apps Script project

1. Go to [script.google.com](https://script.google.com)
2. Click **New project**
3. Delete all the default code in the editor

### Step 2 — Paste the script

1. Open `dist/InvoiceTracker.gs` from this repo
2. Select all the contents → copy
3. Paste it into the Apps Script editor
4. Press **Ctrl+S** to save

### Step 3 — Enable advanced services

In the Apps Script editor:
1. Click **Services** (+ icon on the left sidebar)
2. Add **Gmail API** (v1)
3. Add **Drive API** (v2)
4. Click Save

### Step 4 — Run setup

1. In the editor, select `setup` from the function dropdown
2. Click **Run**
3. Authorize the permissions when prompted (your data stays in your own account)
4. This creates your spreadsheet and the `InvoiceTracker` Gmail label

### Step 5 — Go live

1. Click **Project Settings** (gear icon) → **Script Properties**
2. Add a property: `DRY_RUN` = `false`
3. Back in the editor, run `installTrigger` — this sets up an automatic run every **10 minutes** (so you never have to press Run again)

> Want a different schedule? You can also run `installTriggerEvery5Min()`, `installTriggerEvery15Min()`, or `installTriggerHourly()` instead. You only need to run one of them.

### Step 6 — Create a Gmail filter

1. In Gmail, click the search bar → **Show search options**
2. Set `From` to your invoice senders (e.g. `billing@vendor.com`)
3. Click **Create filter** → check **Apply the label** → select `InvoiceTracker`
4. Click **Create filter**

**That's it.** Once labeled, invoices are picked up automatically on the schedule you chose and written to your spreadsheet. No manual runs needed going forward.

---

## What it does

- Watches Gmail for emails with the `InvoiceTracker` label
- Extracts: invoice number, date, due date, vendor, amount, currency, tax
- Writes each invoice to the master **Ledger** tab and its own **monthly tab**
  (e.g. "July 2026", "August 2026")
- Handles PDF and image attachments via OCR
- Skips duplicates automatically
- Flags anything it's unsure about as `needs_review` instead of guessing
- Emails you an alert if something goes wrong

---

## Your spreadsheet layout

```
📊 Invoice Tracker (in your Google Drive)
  ├── Ledger          ← every invoice, all time
  ├── October 2026    ← auto-created per month
  ├── September 2026
  ├── ...
  ├── KeyIndex        ← dedupe tracking (don't edit)
  ├── PendingQueue    ← processing queue (don't edit)
  └── Log             ← execution logs
```

---

## Privacy & safety

- **Your data never leaves Google.** The script only talks to Gmail, Drive,
  Sheets, and Docs — all within your own account.
- **No external servers, no API keys, no third-party services.**
- Each person who installs this gets their own completely separate spreadsheet.
  Nothing is shared between users.
- The script requests these OAuth scopes:
  - `https://mail.google.com/` — read your Gmail (required to fetch emails)
  - `spreadsheets` — write to your spreadsheet
  - `drive.file` — create temporary OCR files (deleted after use)
  - `documents` — read OCR output
  - `script.scriptapp` — manage the hourly trigger
- `DRY_RUN=true` is the default — nothing is written until you explicitly set it
  to `false`.

---

## Maintenance functions

Run these from the Apps Script editor when needed:

| Function | What it does |
| --- | --- |
| `setup()` | Creates spreadsheet + label. Safe to re-run. |
| `installTrigger()` | Sets up auto-run every 10 minutes (default). Run once. |
| `installTriggerEvery5Min()` | Auto-run every 5 minutes. |
| `installTriggerEvery15Min()` | Auto-run every 15 minutes. |
| `installTriggerHourly()` | Auto-run every hour. |
| `uninstallRunTriggers()` | Remove all auto-run triggers. |
| `run()` | Manual run (same as the hourly trigger). |
| `resetSync()` | Clears the Gmail history cursor. Use if sync gets stuck. |
| `wipeLedger()` | Clears all data rows (keeps headers). Use to start fresh. |
| `probeLabel(5)` | Inspect the last 5 labelled emails — no writes. |

---

## Status column guide

| Status | Meaning |
| --- | --- |
| `ok` | Extracted cleanly, high confidence |
| `needs_review` | Extracted but low confidence — check manually |
| `portal_manual` | Email just links to an online portal — nothing to extract |
| `needs_review_encrypted` | PDF is password-protected |
| `needs_review_no_content` | Email had no readable content |

---

## For developers

The project uses multiple source files that are bundled into `dist/InvoiceTracker.gs`
by `node tools/build-bundle.js`.

| File | Purpose |
| --- | --- |
| `00_Config.gs` | Script Properties accessors, sheet schema, constants |
| `10_Lib.gs` | md5, cell sanitising, retry/backoff, run clock, logging |
| `20_Identity.gs` | Layered dedupe keys + KeyIndex rows |
| `30_Sync.gs` | Label resolution, history polling, backfill, gap recovery |
| `40_Extract.gs` | Pure extraction engine (anchors, amounts, dates, JSON-LD) |
| `50_Router.gs` | Sender→template routing, record extraction, status mapping |
| `60_Sheets.gs` | Spreadsheet/schema bootstrap, batched writes, monthly tabs |
| `70_Probe.gs` | Read-only inspection entry points |
| `80_Tests.gs` | Self-tests for the pure logic |
| `90_Main.gs` | Pipeline orchestration, `run()`, `setup()`, triggers |
| `Fixtures.gs` | Synthetic test fixtures |
| `tools/local-tests.js` | Run tests under Node (no deployment needed) |

```bash
# Run tests locally
node tools/local-tests.js

# Rebuild the single-file bundle
node tools/build-bundle.js
```

To deploy with clasp:
```bash
npm install
npm run login
npm run create   # first time only
npm run push
```

---

## Quotas

- Google Apps Script triggers: ~90 min/day total on a free account
- Each run is capped at 5.3 min (safely under the 6-min hard limit)
- If a run is cut short, work resumes on the next hourly trigger — no data is lost
