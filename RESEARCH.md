# Email → Invoice → Google Sheets: Research Notes

**Scope:** personal tool for one Gmail account. Goal = connect a Gmail account, detect invoice/receipt
emails, extract fields, append rows to a Google Sheet automatically. Budget: $0.

> Invoices come from a **small set of partnered brands** → extraction routes by vendor.
> See `VENDOR-TEMPLATES.md` for the per-brand template design.
> See `REFERENCES.md` for the GitHub repos worth learning from.
> See `RISKS.md` for the adversarial audit and `SOLUTIONS.md` for the fixes.
> See `DECISIONS.md` for decided/open items (detection, scope, deferred validation).

---

## 1. Decision: Google Apps Script

Chosen over Python/Node/no-code because it is the only option that is genuinely free AND requires no
server AND requires no OAuth setup.

| Requirement | Apps Script |
|---|---|
| Cost | $0, no credit card |
| Hosting | None — runs on Google's servers |
| OAuth setup | None — `GmailApp` + `SpreadsheetApp` are built in |
| PDF/image OCR | Free via Drive conversion (within quota) |
| Scheduling | Built-in time-driven triggers |
| Downside | 6 min per execution; JS only; OCR imperfect |

Python/Node would need a Cloud project, OAuth client, consent screen, token storage, and a host.
That is more setup and more failure points for a single-user tool.

---

## 2. Quotas we must design around (consumer Gmail account)

Source: https://developers.google.com/apps-script/guides/services/quotas

| Limit | Consumer (gmail.com) | Workspace |
|---|---|---|
| Email read/write | 20,000 / day | 50,000 / day |
| **Files converted (OCR)** | **2,000 / day** | 4,000 / day |
| Spreadsheets created | 250 / day | 3,200 / day |
| Triggers total runtime | 90 min / day | 6 hr / day |
| Properties read/write | 50,000 / day | 500,000 / day |
| **Script runtime** | **6 min / execution** | 6 min / execution |
| Triggers per script | 20 | 20 |

**The binding constraint is 6 min/execution.** Processing must be chunked: handle N emails per run,
save progress, let the next trigger continue. Never assume all mail fits in one run.

Drive OCR conversion budget is 2,000 files/day — effectively unlimited for one person.

---

## 3. Detection: which emails are invoices

Gmail search operators that matter (source: support.google.com/mail/answer/7190):

| Operator | Use |
|---|---|
| `category:purchases` | Gmail's own "Purchases" category — invoices/receipts |
| `has:attachment` | Only mail with attachments |
| `filename:pdf` / `filename:jpg` / `filename:png` | Filter by attachment type |
| `subject:(invoice OR receipt OR bill OR statement OR "order confirmation")` | Subject keywords |
| `from:(billing@ OR invoice@ OR accounts@ OR receipts@)` | Sender patterns |
| `newer_than:7d` | Time window |
| `has:nouserlabels` | Candidate for "not yet processed" |
| `"grand total"` / `"amount due"` | Body phrase |

Notes / gotchas:
- Gmail search does **not** index the *contents* of attachments — only attachment **filename** and the
  email body/subject. So detection is filename + subject + body based.
- Negative operators are imperfect (conversations can still appear if one message matches).
- Use **multiple queries combined with OR / `{}`**, then **dedupe by message ID**.

Suggested strategy: run a small set of queries (e.g. purchases category, subject keywords, filename
pdf/jpg/png) → union results → dedupe on `messageId` → then run an actual "is this an invoice?" check
in code on the body text before committing.

---

## 4. Extraction: three source types

Emails contain invoice data in three places, each needing a different path.

### A. Email body (text / HTML)
- `GmailMessage.getPlainBody()` for text, `getBody()` for HTML.
- Strip HTML tags, decode entities, then regex the fields.
- Most reliable source when present.

### B. PDF attachments (text-based)
- Apps Script cannot parse PDF bytes natively (no pdfplumber equivalent).
- **Free path:** Drive converts the PDF into a Google Doc; read the Doc text.
- Works well for PDFs that already contain a text layer. Scanned PDFs fall to path C.

### C. Images / scanned PDFs → OCR
- Drive OCR: convert the image/PDF into a Google Doc; Drive runs OCR and puts the recognized text in
  the Doc body. This is the **free OCR** path.
- Confirmed by Drive "Import to Google Docs types" — set the Google Doc `mimeType` when creating the file:
  `application/vnd.google-apps.document`.
- Accuracy is variable. Handwriting, low-res photos, and unusual layouts will produce garbage.
- Image OCR has size limits (~2 MB class) — large photos may need downscaling/skipping.
- **Therefore:** flag OCR-sourced rows with a lower confidence value and route them to review.

### The OCR trick in Apps Script (Advanced Drive Service)
```
// blob = the attachment blob
const docFile = Drive.Files.create(
  { name: 'ocr-' + name, mimeType: 'application/vnd.google-apps.document' },
  blob
);
const doc = DocumentApp.openById(docFile.id);
const text = doc.getBody().getText();
// delete the temp doc when done
Drive.Files.remove(docFile.id);
```
(Enable the Advanced Drive service in the manifest; alternately `Drive.Files.copy` with a converted
mimeType.) Each conversion consumes the "Files converted" quota.

---

## 5. Field extraction rules (regex starting point)

Target fields and rough patterns — expect to iterate against real mail:

| Field | Pattern idea |
|---|---|
| Invoice # | `/(?:invoice|inv|ref|#)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i` |
| Total amount | `/(?:grand total|total amount|amount due|balance due|total)\D{0,20}([$€£]?\s?[\d,]+\.\d{2})/i` |
| Currency | `/(USD|EUR|GBP|PHP|AUD|CAD|\$|€|£|₱)/` |
| Invoice date | `/\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/` and `/\b(\d{1,2}\s+(Jan|Feb|...)\w*\s+\d{4})\b/i` |
| Due date | same date patterns gated by a nearby "due" keyword |
| Vendor | prefer the email `From:` display name / domain; fall back to first line of doc |

**Confidence scoring:** count how many required fields matched (e.g. amount + date + invoice#).
- 3/3 → high, write to main tab.
- 1-2/3, or OCR-sourced → write to staging with `Needs review`.
- 0 → log as skipped, do not write.

Watch-outs:
- Thousands separators (`1,234.56`) and locale formats (`1.234,56`).
- Currency symbol vs code mismatch.
- The word "total" appears many times (subtotal, tax total) — prefer "grand total"/"amount due".
- Dates: ambiguity between DD/MM and MM/DD is unavoidable — store the raw string alongside normalized.

---

## 6. Reliability design (the "no errors / safe data" requirement)

Polling is safer than real-time: Google's own docs state Pub/Sub push notifications "might be delayed
or dropped." A missed push = a silently lost invoice. Scheduled polling with a bookmark cannot
silently skip.

1. **Scheduled polling** — time-driven trigger (e.g. every 15 min).
2. **Bookmark** last-processed timestamp/message in `PropertiesService`; never rely on re-scanning all mail.
3. **Idempotency / dedupe (most important):** key = `messageId + attachmentName`; skip if already present
   in the sheet. Prevents duplicate rows on retries.
4. **Non-destructive:** never delete, archive, or move mail. Read-only + optional `Processed` label.
5. **Staging tab + confidence:** low-confidence and OCR rows go to a review tab, not the trusted data.
6. **LockService** so overlapping triggers don't double-process.
7. **Per-email try/catch:** one malformed email must not abort the whole batch.
8. **Run log tab:** timestamp, query, count found, count written, errors.
9. **DRY_RUN flag:** parse and report without writing.
10. **Chunking:** process a bounded number per run to stay under 6 minutes; resume next run.

---

## 7. Sheet schema

```
Date Received | From | Subject | Vendor | Invoice # | Invoice Date | Amount | Currency | Due Date
| Source (body/PDF/OCR) | Confidence | Message ID | Attachment | Link | Status
```

`Message ID + Attachment` = the dedupe key. `Status` = `Auto` / `Needs review`.

---

## 8. Optional upgrade (still cheap, later)

If regex extraction proves too weak for messy invoices, an LLM can parse the extracted text into
structured fields. Options: Gemini via Apps Script (Vertex AI advanced service) or an external API.
This is an accuracy upgrade, not required for v1 — and may introduce per-call cost, so it breaks the
strict $0 rule unless within a free tier.

---

## 9. Open questions to resolve while building

- Real-world sample: how many invoices are scanned images vs text PDFs vs body-only?
- Do invoices come from a small set of known vendors (allow vendor-specific templates = far higher accuracy)?
- Is DD/MM or MM/DD expected locally?
- Currency: single currency or mixed?
