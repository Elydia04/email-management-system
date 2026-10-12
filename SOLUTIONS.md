# Solution Designs

Concrete fixes for the issues in `RISKS.md`. Two are called out for depth because they change the
core architecture: **content-hash identity** (C2/H3) and **historyId incremental sync** (C1/H5-adjacent).

---

## Design principles

1. **Bias against data loss, not against duplicates.** A duplicate row is visible and fixable. A
   *dropped* invoice is silent and dangerous. So every ambiguous decision resolves to "process it,
   flag it" — never "skip it."
2. **Atomic by construction.** Wherever possible, make a write a single operation so a hard 6-min kill
   can't leave half-state. Dedupe is the safety net for the cases where that isn't possible.
3. **Decouple discovery from processing.** Finding what needs work is cheap; doing the work is
   expensive. Splitting them means the 6-min limit can never cause a *missed* message — only a
   *deferred* one.
4. **Never trust extracted text.** It is validated (shape/type) and sanitized (formula injection)
   before it touches a cell.

---

## Solution A — Content-hash identity (replaces messageId as primary key)

### The identity problem

`messageId` is a *transport* identifier, not an *invoice* identifier. The same invoice emailed twice,
forwarded, or re-sent by the vendor gets a new `messageId` → duplicate. And storing keys only in
`PropertiesService` caps us at ~500 KB and dies on hand-edits.

### Layered keys

Each processed item produces up to three keys. We store **all** of them and dedupe if **any** matches.

| Layer | Key | Strength | When available |
|---|---|---|---|
| `ATT` | `att:` + MD5 of the attachment's **raw bytes** | Strongest — identical bytes ⇒ identical invoice | Attachment exists |
| `MSG` | `msg:` + `messageId` + `\|` + `attachmentName` | Medium — stable per delivery | Always (fallback) |
| `CNT` | `cnt:` + MD5 of `vendor\|invoiceNo\|amount\|currency\|invoiceDate` | Weak — can false-match | Only when extraction is confident |

```js
/** MD5 → lowercase hex. Accepts a string or a byte array. */
function md5Hex_(input) {
  const bytes = (typeof input === 'string') ? Utilities.newBlob(input).getBytes() : input;
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(b => (b & 0xff).toString(16).padStart(2, '0'))
    .join('');
}

function buildKeys_(ctx) {
  const keys = [];
  if (ctx.attachmentBytes) keys.push({ type: 'ATT', key: 'att:' + md5Hex_(ctx.attachmentBytes) });
  keys.push({ type: 'MSG', key: 'msg:' + ctx.messageId + '|' + (ctx.attachmentName || '') });
  if (ctx.confidence >= 0.8 && ctx.invoiceNo) {          // conservative gate
    keys.push({ type: 'CNT', key: 'cnt:' + md5Hex_(
      [ctx.vendor, ctx.invoiceNo, ctx.amount, ctx.currency, ctx.invoiceDate].join('|')));
  }
  return keys;
}
```

### Why `CNT` is gated

`CNT` can only safely be trusted when it has enough entropy. If `invoiceNo` failed to extract, the key
degrades to `vendor|amount|date` — and two *distinct* invoices with the same amount and date would
collide → **a dropped invoice**. That's the one failure we refuse to risk. So `CNT` is only built when
`invoiceNo` is present *and* confidence is high. Otherwise we fall back to `MSG`, which errs toward a
duplicate row.

### Dedupe policy

```
seen = loadKeySet()                 // one range read at run start
for each candidate:
  if any key in seen  -> SKIP (log "already processed")
  else                -> process, then record ALL its keys
```

### Storage — atomic and self-healing

- The **primary key lives in the ledger row itself** (hidden `DedupeKey` column). Row + key are written
  in one `setValues()` call, so a kill can never produce a row without its key.
- Alternate keys go in a **`KeyIndex`** tab: `KeyType | KeyHash | MessageId | AttachmentName | Vendor |
  InvoiceNo | LedgerRow | FirstSeen`.
- At run start, **`KeyIndex` is reconciled from the ledger's `DedupeKey` column** — if the two disagree
  (e.g. crash between the two writes), the ledger wins and the index is rebuilt for those rows. This
  makes the crash window self-correcting.
- Never hand-edit `KeyIndex`; treat it as a derived store.

### Scale

At personal volume this is trivial: loading a column of 32-char hashes for 50k invoices is well under a
megabyte. No `CacheService` needed initially (and note: cache has size caps + ~6h expiry, so it is not
durable — not a substitute for the store).

---

## Solution B — historyId incremental sync (replaces date-window search)

### Why

Date-window search (`newer_than:1d`) has a race: a message arriving *between* runs near a window edge
can be missed, and a skipped run (quota, error, downtime) creates a permanent gap. `historyId` is a
monotonic mailbox cursor: **it cannot skip a message**, even if the poll is late.

### State

| Key | Where | Purpose |
|---|---|---|
| `lastHistoryId` | Script Properties | Mailbox cursor (tiny — fits easily) |
| `backfillDone` | Script Properties | Whether the initial seed completed |
| pending queue | `PendingQueue` tab | Discovery results awaiting processing |
| `lastRunIso` | Script Properties | Gap guard (see below) |

### Two-phase run: discovery → processing

```js
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;          // another run is active
  try {
    const deadline = Date.now() + 5.3 * 60 * 1000;   // 6-min cap minus buffer
    discover_(deadline);       // fast: ids only, no content
    processQueue_(deadline);   // slow: chunked, resumable
  } finally {
    lock.releaseLock();
  }
}
```

**Discovery is cheap** (id-only metadata), so it virtually always completes. **Processing is chunked**
and resumes from the queue across runs. A kill mid-processing loses *no* messages — they're still in
the queue.

### Bootstrap (no gap, ever)

Order matters here:

```js
const H0 = Gmail.Users.getProfile('me').historyId;   // 1. capture cursor BEFORE backfill
enqueueSearchMatches_('newer_than:365d ...');        // 2. can span multiple runs
setProp('lastHistoryId', H0);                        // 3. resume from H0
setProp('backfillDone', true);
```

Because `H0` is captured *first*, anything arriving during the (possibly long) backfill is still picked
up by history on the next run. And if the backfill search also caught those messages, the content-hash
dedupe absorbs the overlap.

### Normal run

```js
let cursor = getProp('lastHistoryId');
let pageToken;
do {
  const res = Gmail.Users.History.list('me', {
    startHistoryId: cursor, maxResults: 500, pageToken
  });
  for (const rec of res.history || []) {
    for (const added of rec.messagesAdded || []) {   // ONLY messagesAdded
      enqueue_(added.message.id);
    }
    cursor = rec.id;                                 // resumable even if we stop mid-list
  }
  pageToken = res.nextPageToken;
  setProp('lastHistoryId', cursor);                  // advance as we collect
} while (pageToken && Date.now() < deadline);
```

Two deliberate choices:

- **Filter to `messagesAdded` only.** Our own label writes appear as `labelsAdded`; without this filter
  we'd reprocess on every run — a self-inflicted infinite loop. (This is also why we advance the cursor
  *after* collecting: the queue is the work order, the cursor is just the discovery frontier.)
- **Advance `lastHistoryId` per history record.** Each record carries its own `id`, so even a bounded
  listing is resumable without trying to persist short-lived page tokens.

### 404 recovery (history expired)

Gmail's history retention is finite (~a week, and documented as not guaranteed). With 30–60 min polls
we stay far inside it, but we must handle the stale case:

```js
try {
  // History.list(...)
} catch (e) {
  if (isNotFound_(e)) {
    // historyId too old — recover via a bounded search over the gap, then reset
    enqueueSearchMatches_(gapQueryFrom(lastSuccessfulRunIso_()));
    setProp('lastHistoryId', Gmail.Users.getProfile('me').historyId);
    log_('WARN', 'History gap — recovered via search; possible duplicates.');
    alert_('History gap recovered — verify recent invoices.');
  } else throw e;
}
```

Also add a **gap guard**: if `now - lastRunIso > 24h` (machine was off, trigger disabled), assume a gap
and run the search fallback regardless. This is why we keep the search path at all.

### Gotchas captured

- **Alert emails pollute the stream.** Our own alert mail is a new message → appears in
  `messagesAdded`. Filter out messages from self, and apply the same query filters as the search path.
- **Content fetch.** History message stubs have no payload → fetch via `GmailApp.getMessageById(id)`
  (keeps one extraction code path) and handle "message deleted" gracefully.
- **Deleted messages** may be enqueued then vanish → drop from queue and log, don't error.

---

## Solution C — the remaining risks, concretely

### C1 — 90 min/day runtime budget
Trigger every **60 min** initially (24 runs/day). Early-exit in ~1s when the queue is empty and history
returns nothing. Log `durationMs` per run; a `Log` tab sum tells us the daily burn before we hit the wall.
Reminder: 20 triggers/script, 30 concurrent/user — one trigger only.

### C3 — time guard, atomic writes
`MAX_EXECUTION_MS = 5.3 * 60 * 1000`. Notifications are wrapped per-email in try/catch. Rows are buffered
in memory and flushed with **one `setValues()`** (e.g. every 50 rows, and always before the deadline),
inside the line of the lock that guards the write.

### C4 — formula injection
```js
function sanitizeCell_(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim();
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // defang formula start
  return s;
}
```
Amounts/dates are parsed to real numbers/dates with strict regex; anything that fails validation goes
to the row as **text + `Needs review`**, never as a coerced number.

### C5 — inline images & HTML-only bodies
- If `getPlainBody()` is empty → strip HTML: drop `<style>/<script>`, replace tags with spaces, decode
  entities. (No `DOMParser` in Apps Script — must be regex, so keep it simple and linear.)
- If there are no true attachments but the HTML contains `<img>` `cid:` references, collect the inline
  image attachments and send them down the OCR path. Identity via `ATT` hash dedupes the same image.
- Log any message where no source yielded text → visible, not silent.

### C6 — OCR column scrambling
When reading the converted Google Doc, walk **`body.getTables()`** as well as flat text. In a 2-column
table, read cells as `{label: cell[i], value: cell[i+1]}` pairs — the pairing survives flattening much
better than paragraph text does. Merge both sources; table-derived pairs win on conflict. OCR-sourced
rows start at reduced confidence → `Needs review`.

### H1 — anchor collisions
```js
// match the most specific label first, require a word boundary
const ANCHORS = ['invoice number', 'invoice no', 'invoice #', 'invoice'];
```
Rules: (a) longest label first so `invoice` can't shadow `invoice number`; (b) `\b` boundaries;
(c) **validate the captured value's shape** — an invoice number must not match a date or currency
pattern; (d) explicit per-field `exclude` list (e.g. never take `total`/`date` as an invoice number).

### H2 — amount & locale
- Both separators present (`1.234,56` or `1,234.56`) → unambiguous, derive from the last separator.
- Only one separator + 3 trailing digits (`1.234`) → ambiguous → flag lower confidence, prefer the
  value that also satisfies the total cross-check (sum of line items ≈ total) when available.
- Prefer `grand total` / `amount due` anchors over bare `total`.
- Store **raw string + normalized number + currency**; never assume 2 decimals (JPY=0, KWD=3).

### H7 — portal links / password-protected PDFs
Route to explicit buckets, each with a `Reason` note:
- **Portal/manual**: no attachment + login/download phrasing (`sign in`, `view invoice`, `download
  your invoice`, `account`) → store the link for a human.
- **Encrypted**: conversion throws a distinct error → `Needs review (password-protected)`.
- **No text**: nothing extracted → `Needs review (no content)`.

### H5/H6 — retry, logging, alerting
```js
function withRetry_(fn, tries = 4, baseMs = 500) {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      if (i >= tries - 1 || !isTransient_(e)) throw e;
      Utilities.sleep(baseMs * Math.pow(2, i) + Math.floor(Math.random() * 250));
    }
  }
}
// isTransient_: 429/5xx, "Service invoked too many times", "Rate Limit Exceeded"
```
Every run writes a `Log` row (start, end, durationMs, discovered, processed, skipped, errors). On error
or gap: `MailApp.sendEmail` to self (mind the 100 recipients/day consumer cap) + heartbeat check
("no successful run in 24h → warn"). Note the alerter must not depend on the pipeline it's warning about.

### H8 — timezone
Pin the project timezone in `appsscript.json`. Format dates with an explicit tz and store ISO-8601 with
offset. Never rely on the default.

### H9 — regex hygiene
- No module-level `g`-flagged regexes (shared `lastIndex` state is a classic silent bug); either omit
  `g` or reset `lastIndex = 0` before each use.
- Cap input length before matching (e.g. first 100k chars) and keep patterns linear (no nested
  quantifiers) to prevent catastrophic backtracking on long OCR text.

### H10 — temp doc cleanup
All OCR conversions are created in one dedicated **`TempInvoiceOCR`** folder. At the start of each run,
trash anything in it older than an hour. Keeps Drive clean and bounds quota waste.

### H11 — per-message state
The queue and key index are keyed per **message + attachment**, never per thread. Gmail labels are
cosmetic only, so a thread's label state can never cause a skipped message.

### H12 — drift detection covers routing too
Per sender-domain counters in the `Vendors` tab: `matched_template` vs `fell_back_to_generic`. Also per
vendor+field extraction success rate over a rolling window. Alert when routing hit-rate or field
success drops — catches a vendor changing their **sending domain** as well as their layout.

### M3 — scopes
`GmailApp` already demands `https://mail.google.com/`, so the advanced Gmail service adds nothing new.
Target manifest:
```json
"oauthScopes": [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/script.scriptapp"
]
```
`drive.file` (not full `drive`) is enough for files *we* create — the OCR temp docs and our archive
folder. Only widen it if you want to write into an existing user-chosen folder.

---

## State map (single source of truth)

| Store | Contents | Mutability |
|---|---|---|
| `Ledger` tab | One row per invoice, incl. hidden `DedupeKey` | User-facing, editable |
| `KeyIndex` tab | All keys (ATT/MSG/CNT) → ledger row | Derived, never hand-edited |
| `PendingQueue` tab | Discovered message ids awaiting processing | Working state |
| `Vendors` tab | Per-vendor enable/notes/stats | User-editable config |
| `Log` tab | Run + error history | Append-only |
| Script Properties | `lastHistoryId`, `backfillDone`, `lastRunIso`, small flags | Tiny scalars only |

Rule of thumb: **scalars → Properties; collections → sheets.** Properties' 500 KB total is respected
by construction because nothing unbounded ever goes there.

---

## Recommended build order

Safety-first, because these are the parts that are hard to retrofit:

1. `lib` — `md5Hex_`, `sanitizeCell_`, `withRetry_`, time guard, logging, lock.
2. `identity` — layered keys + `KeyIndex` load/reconcile.
3. `sync` — historyId discovery + pending queue + bootstrap + 404/gap recovery.
4. `extract` — anchor engine (longest-match, shape validation, tables), HTML fallback, portal/encrypted
   detection.
5. `sheets` — batched atomic writes, ledger + staging + reason buckets.
6. `vendor` — registry + routing (incl. platform-domain escalation) + drift counters.
7. `probe` — inspection mode so real samples can be tuned without writing anything.

Everything above is testable with synthetic fixtures *before* the first real invoice arrives.
