/**
 * 30_Sync.gs — discovery via Gmail history, plus the pending queue.
 *
 * Design (see SOLUTIONS.md solution B and DECISIONS.md D1):
 *   - A Gmail filter labels invoice mail at delivery.
 *   - Discovery polls Gmail history for that label. History has no query
 *     language, but it does support `labelId` + `historyTypes`, so discovery
 *     stays server-side filtered.
 *   - Discovery (cheap, ids only) and processing (expensive) are decoupled by
 *     the PendingQueue, so a hard 6-min kill can only defer work, never lose it.
 */

let __QUEUED = null;

function queuedSet_() {
  if (!__QUEUED) {
    __QUEUED = {};
    loadQueuePending_().forEach(function (r) { if (r.messageId) __QUEUED[r.messageId] = true; });
  }
  return __QUEUED;
}

/** Return only ids not already queued, and mark them queued. */
function filterNew_(ids) {
  const s = queuedSet_();
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id && !s[id]) { s[id] = true; out.push(id); }
  }
  return out;
}

/** Resolve (creating if needed) the Gmail label used as the discovery gate. */
function resolveInvoiceLabelId_() {
  const cached = cfg_(PROP.INVOICE_LABEL_ID, '');
  if (cached) return cached;
  const name = invoiceLabelName_();
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  const id = label.getId();
  setProp_(PROP.INVOICE_LABEL_ID, id);
  log_('INFO', 'invoice label "' + name + '" id=' + id);
  return id;
}

function discover_(clock) {
  resolveInvoiceLabelId_();
  if (String(cfg_(PROP.BACKFILL_DONE, '')) !== 'true') {
    backfill_(clock);
    return;
  }
  pollHistory_(clock);
}

// ---- bootstrap --------------------------------------------------------------

/**
 * Seed the queue from existing labelled mail, then hand over to history.
 *
 * H0 is captured BEFORE the search so anything that arrives during the (possibly
 * multi-run) backfill is still covered by history afterwards.
 */
function backfill_(clock) {
  const labelName = invoiceLabelName_();
  if (!cfg_(PROP.BACKFILL_H0, '')) {
    setProp_(PROP.BACKFILL_H0, Gmail.Users.getProfile('me').historyId);
  }
  let offset = cfgInt_(PROP.BACKFILL_OFFSET, 0);
  while (!clock.expired()) {
    const batch = GmailApp.search('label:"' + labelName + '"', offset, 100);
    if (!batch.length) { finishBackfill_(); return; }
    const ids = [];
    for (let i = 0; i < batch.length; i++) {
      const msgs = batch[i].getMessages();
      for (let j = 0; j < msgs.length; j++) ids.push(msgs[j].getId());
    }
    const fresh = filterNew_(ids);
    if (fresh.length) appendQueue_(fresh);
    offset += 100;
    setProp_(PROP.BACKFILL_OFFSET, offset);
  }
  log_('WARN', 'backfill incomplete at offset ' + offset + '; resuming next run');
}

function finishBackfill_() {
  setProp_(PROP.LAST_HISTORY_ID, cfg_(PROP.BACKFILL_H0, Gmail.Users.getProfile('me').historyId));
  setProp_(PROP.BACKFILL_DONE, 'true');
  delProp_(PROP.BACKFILL_OFFSET);
  log_('INFO', 'backfill complete; history cursor set');
}

// ---- incremental polling ----------------------------------------------------

function pollHistory_(clock) {
  const labelId = cfg_(PROP.INVOICE_LABEL_ID, '');
  if (!labelId) { log_('ERROR', 'no invoice label id; run setup() first'); return; }

  let cursor = cfg_(PROP.LAST_HISTORY_ID, '');
  if (!cursor) {
    setProp_(PROP.LAST_HISTORY_ID, Gmail.Users.getProfile('me').historyId);
    log_('INFO', 'no cursor yet; seeded from current historyId');
    return;
  }

  let pageToken = null;
  let pages = 0;
  while (!clock.expired() && pages < 100) {
    pages++;
    let res;
    try {
      res = Gmail.Users.History.list('me', {
        startHistoryId: cursor,
        labelId: cfg_(PROP.INVOICE_LABEL_ID, ''),
        historyTypes: ['labelAdded'],
        maxResults: 500,
        pageToken: pageToken
      });
    } catch (e) {
      if (isNotFound_(e)) { recoverHistoryGap_(); return; }
      throw e;
    }

    const hist = res.history || [];
    const ids = [];
    for (let i = 0; i < hist.length; i++) {
      const added = hist[i].labelsAdded || [];
      for (let j = 0; j < added.length; j++) {
        const a = added[j];
        if (a.labelIds && a.labelIds.indexOf(cfg_(PROP.INVOICE_LABEL_ID, '')) !== -1 && a.message) {
          ids.push(a.message.id);
        }
      }
      if (hist[i].id) cursor = String(hist[i].id);
    }
    const fresh = filterNew_(ids);
    if (fresh.length) {
      appendQueue_(fresh);
      log_('INFO', 'discovered ' + fresh.length + ' labelled message(s)');
    }
    // Advance the cursor per record so a bounded listing stays resumable.
    setProp_(PROP.LAST_HISTORY_ID, cursor);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
}

/**
 * History expired (404). Recover by re-scanning the label, then reset the
 * cursor to now. Duplicates are expected and absorbed by content-hash dedupe.
 */
function recoverHistoryGap_(clock) {
  log_('WARN', 'history cursor expired (404) — recovering via label search');
  alert_('History gap recovered',
    'The Gmail history cursor expired, so a full label re-scan was run. ' +
    'Duplicate rows are possible, but the content-hash dedupe should absorb them.');

  const labelName = invoiceLabelName_();
  let offset = 0;
  while (!clock.expired()) {
    const batch = GmailApp.search('label:"' + labelName + '"', offset, 100);
    if (!batch.length) break;
    const ids = [];
    for (let i = 0; i < batch.length; i++) {
      const msgs = batch[i].getMessages();
      for (let j = 0; j < msgs.length; j++) ids.push(msgs[j].getId());
    }
    const fresh = filterNew_(ids);
    if (fresh.length) appendQueue_(fresh);
    offset += 100;
  }
  setProp_(PROP.LAST_HISTORY_ID, Gmail.Users.getProfile('me').historyId);
}
