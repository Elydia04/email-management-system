# Reference Repositories (GitHub)

Found via the GitHub Search API. Assessment: this is a **niche** area — no large, actively maintained,
production-grade repo matches exactly. But several are excellent **references** for specific patterns,
and two or three are close enough to learn a lot from.

**Reality check:** none of them implement the **vendor-template registry** approach we designed. They
do generic regex or LLM extraction. So our design is differentiated; treat these as pattern sources,
not a codebase to fork.

---

## Top references (verified license + structure)

| Repo | Stars | Lang | License | Updated | Why it matters |
|---|---|---|---|---|---|
| **[yahm0/InvoiceTrackerAutomation](https://github.com/yahm0/InvoiceTrackerAutomation)** | 2 | JS (Apps Script) | **MIT** | 2026-03 | Closest match. Gmail → Sheets, multi-sender, attachments → Drive, **checkpoint/resume**, optional OCR, config via Script Properties. |
| **[moghaddas/qonto-invoice-ledger](https://github.com/moghaddas/qonto-invoice-ledger)** | 1 | JS (Apps Script) | **MIT** | 2026-08 | Best **architecture**: modular `src/` (Capture/Config/Drive/Gemini/Ledger/Reconcile/SelfTest), **DRY_RUN-by-default**, decision notes per row. Gemini-based extraction + bank reconciliation. |
| **[tanaikech/UnlockSmartInvoiceManagementWithGeminiAPI](https://github.com/tanaikech/UnlockSmartInvoiceManagementWithGeminiAPI)** | 14 | JS (Apps Script) | **MIT** | 2024-08 | Highest-credibility author (Tanaike). Gmail attachment → **Gemini** parse → Sheet, on a time-driven trigger. The LLM path. |
| **[wtnabe/gas-gmail-drive-etl](https://github.com/wtnabe/gas-gmail-drive-etl)** | 2 | JS (Apps Script) | **BSD-2** | 2025-01 | A clean **pluggable library**: query → filter → pluggable `extractProcess` → SheetStore + FolderStore. Good separation-of-concerns model. (Docs in Japanese.) |
| **[JayceeMolina/gs-invoice-tracker](https://github.com/JayceeMolina/gs-invoice-tracker)** | 1 | JS (Apps Script) | **MIT** | 2026-08 | Tiny (~9KB), readable baseline: search queries array, dedupe, mark-read, daily summary. |
| **[gachn/gmail-invoice-parser-for-sheets](https://github.com/gachn/gmail-invoice-parser-for-sheets)** | 1 | Apps Script | **Apache-2.0** | 2025-05 | Configurable list of platforms + per-platform keywords/regexes — a simplified cousin of our vendor registry. |
| **[davccavalcante/GetNFePDF4Gmail](https://github.com/davccavalcante/GetNFePDF4Gmail)** | 3 | JS (Apps Script) | **CC0-1.0** | 2024-08 | PDF e-invoice handling from Gmail → Drive. Domain-specific (Brazilian NF-e) but good PDF pipeline reference. |
| **[adolfousier/invoicepilot](https://github.com/adolfousier/invoicepilot)** | 42 | Rust | MIT | 2026-03 | Not our stack, but the most-starred: searches Gmail for invoices/statements → Drive. Useful for *concepts* only. |

### Avoid copying (no license)
- **Ixonblitz-MatOS/google-apps-script-email-invoice-automation** — Apps Script, nice structure
  (`src/` with Config/Parser/GmailProcessor/SheetService/DocService), supports duplicate prevention by
  message id, template Docs → PDF. **But no LICENSE file** → read for ideas, do not copy code.

---

## Patterns we can lift (with attribution)

These are the genuinely valuable finds — things our research said we'd need, already solved:

1. **Execution-time guard + checkpoint/resume** (yahm0) — this is the big one.
   ```js
   const MAX_EXECUTION_MS = 5.5 * 60 * 1000;   // 6-min limit minus a 30s buffer
   if (isApproachingTimeLimit_()) {
     saveCheckpoint_(lastProcessedMessageId, threadIndex);  // resume next trigger
     break;
   }
   ```
   Exactly the chunking problem we flagged. They resume from `threadIndex` saved in Properties.

2. **DRY_RUN defaulting ON** (qonto) — a fresh install extracts and logs but changes nothing until you
   explicitly set `DRY_RUN = false`. Matches our "safe data" requirement almost word for word.

3. **Config via Script Properties with code fallbacks** (yahm0) — constants read
   `getConfig_('KEY', default)`, so IDs/secrets live in Project Settings, not the repo.

4. **Dedupe on `messageId`** (Ixonblitz described; Jaycee implemented) — validates our idempotency key.

5. **Currency symbol → ISO map** (yahm0): `{'$':'USD','€':'EUR','£':'GBP','¥':'JPY','₹':'INR'}`.

6. **Pluggable extractor** (wtnabe) — pass an `extractProcess(message)` function into a generic
   Gmail→Sheet→Drive pipeline. This is essentially the seam where our **vendor-template registry**
   slots in: `extractProcess = routeVendor(message) → applyTemplate()`.

7. **Optional OCR toggle** (yahm0 uses Cloud Vision) — a reminder that there are **two** OCR routes:
   Drive-convert (free, what we chose) vs Cloud Vision (better, may bill). Keep it a toggle.

8. **Self-test module** (qonto `SelfTest.js`) — a runnable self-check separate from production runs.

---

## What this changes for our plan

- **Confirms** our architecture: none of these do vendor-templating, so our registry is the differentiator.
- **De-risks** the 6-min limit: we now have a proven checkpoint/resume pattern to adapt.
- **Reinforces** Dry-run + dedupe + confidence as the safety core.
- **Validates** the optional LLM upgrade (2 of the top repos use Gemini) — but note it needs an API key
  and may leave the strictly-$0 lane.
- **Licenses are mostly permissive** (MIT/Apache/BSD/CC0) → we can legally adapt patterns with
  attribution. The no-license one is ideas-only.

## Suggestion
Use **yahm0** as the structural skeleton reference (checkpointing, config, columns), **qonto** for
architecture/modularity/dry-run, and **wtnabe** for the pluggable-extractor seam — then build our own
vendor-template engine on top. Credit them in a `NOTICE`/README section as required by their licenses.
