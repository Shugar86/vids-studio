// Observe downloads caused by the already-attached frame. This module never
// starts a download, changes browser settings, or searches download history.
const TTL = 15 * 60 * 1000;
const LIMIT = 32;
// One pair of browser-wide listeners, regardless of attached document count.
// Each subscriber retains its own strict document/frame/download correlation.
const downloadHubs = new WeakMap();

function subscribeDownloads(downloads, subscriber) {
  if (!downloads) return () => {};
  let hub = downloadHubs.get(downloads);
  if (!hub) {
    const subscribers = new Set();
    const created = item => { for (const watcher of subscribers) watcher.onCreated(item); };
    const changed = delta => { for (const watcher of subscribers) watcher.onChanged(delta); };
    hub = {subscribers, created, changed};
    downloadHubs.set(downloads, hub);
    downloads.onCreated?.addListener(created);
    downloads.onChanged?.addListener(changed);
  }
  hub.subscribers.add(subscriber);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    hub.subscribers.delete(subscriber);
    if (hub.subscribers.size) return;
    downloads.onCreated?.removeListener?.(hub.created);
    downloads.onChanged?.removeListener?.(hub.changed);
    if (downloadHubs.get(downloads) === hub) downloadHubs.delete(downloads);
  };
}

function fault(code, message) { const error = new Error(message); error.code = code; throw error; }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function mp4Path(value) { return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) && /\.mp4$/i.test(value) && !value.includes('\0'); }

export function createExportWatcher(chromeApi, {now = Date.now} = {}) {
  const jobs = new Map();
  const candidates = new Map();
  const foreignFrameUrls = new Set();
  function reconcile(job, code) { job.state = 'needs_reconciliation'; job.code = code; }
  function expire() {
    for (const [id, item] of candidates) if (now() - item.observedAt > 10000) candidates.delete(id);
    for (const [id, job] of jobs) {
      if (now() - job.started > TTL) {
        if (['armed', 'downloading'].includes(job.state)) reconcile(job, 'EXPORT_WATCH_EXPIRED');
        else if (now() - job.started > TTL * 2) jobs.delete(id);
      }
    }
  }
  function lookup(jobId, sessionId) {
    expire();
    const job = jobs.get(jobId);
    if (!job || job.sessionId !== sessionId) fault('EXPORT_WATCH_NOT_FOUND', 'No export watch belongs to this session and job.');
    return job;
  }
  function pending(sessionId) {
    expire();
    const job = [...jobs.values()].find(job => job.sessionId === sessionId && ['armed', 'downloading'].includes(job.state));
    return job ? {state: job.state, triggerOutcome: job.triggerOutcome,
      expiresAt: new Date(job.started + TTL).toISOString(),
      retryBoundary: 'reconcile_previous_export_before_new_intent'} : null;
  }
  function arm(binding) {
    expire();
    if (!chromeApi.downloads?.onCreated || !chromeApi.downloads?.search) fault('EXPORT_UNAVAILABLE', 'The loaded extension does not provide download observation.');
    if (!binding || !['jobId', 'sessionId', 'frameId', 'documentId'].every(key => validId(binding[key])) || !Number.isInteger(binding.tabId)) fault('INVALID_ARGUMENT', 'Export binding is invalid.');
    if (jobs.has(binding.jobId)) fault('EXPORT_WATCH_EXISTS', 'An export watch cannot be armed a second time.');
    if (jobs.size >= LIMIT) fault('EXPORT_WATCH_CAPACITY', 'Export watch retention is full; wait for expiry.');
    if ([...jobs.values()].some(job => job.sessionId === binding.sessionId && ['armed', 'downloading'].includes(job.state))) fault('EXPORT_WATCH_BUSY', 'This session already has an export watch.');
    if (![...jobs.values()].some(job => ['armed','downloading'].includes(job.state))) foreignFrameUrls.clear();
    jobs.set(binding.jobId, {...binding, started: now(), state: 'armed', triggerOutcome: 'pending', guid: null, url: null, downloadId: null, filename: null});
    return {jobId: binding.jobId, state: 'armed'};
  }
  function onDebuggerEvent(source, method, params = {}) {
    if (method === 'Page.downloadWillBegin' && typeof params.url === 'string' && params.url.length <= 8192 &&
        [...jobs.values()].some(job => ['armed','downloading'].includes(job.state) && job.tabId === source.tabId && (source.sessionId || params.frameId !== job.frameId))) {
      if (foreignFrameUrls.size >= 64) { for (const job of jobs.values()) if (['armed','downloading'].includes(job.state)) reconcile(job, 'DOWNLOAD_EVENT_OVERFLOW'); }
      else foreignFrameUrls.add(params.url);
    }
    if (source.sessionId) return;
    expire();
    for (const job of jobs.values()) {
      if (source.tabId !== job.tabId || !['armed', 'downloading'].includes(job.state)) continue;
      if (method === 'Page.downloadWillBegin') {
        if (params.frameId !== job.frameId || typeof params.url !== 'string' || !params.url || typeof params.guid !== 'string' || params.guid.length > 128 || params.url.length > 8192) continue;
        if (job.guid && job.guid !== params.guid) { reconcile(job, 'AMBIGUOUS_PAGE_DOWNLOAD'); continue; }
        if (!/\.mp4$/i.test(params.suggestedFilename || '')) { reconcile(job, 'UNEXPECTED_EXPORT_TYPE'); continue; }
        job.guid = params.guid; job.url = params.url; job.state = 'downloading';
        for (const item of candidates.values()) correlate(job, item);
      } else if (method === 'Page.downloadProgress' && job.guid === params.guid) {
        if (params.state === 'canceled') reconcile(job, 'BROWSER_DOWNLOAD_CANCELED');
        else if (params.state === 'completed') job.cdpCompleted = true;
      }
    }
  }
  function correlate(job, item) {
    if (!['armed', 'downloading'].includes(job.state)) return;
    if (job.url && item.url !== job.url && item.finalUrl !== job.url) return;
    const started = Date.parse(item.startTime);
    if (!Number.isFinite(started) || started < job.started || started > now() + 1000) return;
    // Empty/origin-only referrers cannot distinguish a same-URL download in
    // another tab. Fail closed; the isolated HTTP/redirect/blob probe supplies
    // the full initiating document in all three verified cases.
    try {
      const referrer = new URL(item.referrer);
      if (referrer.protocol === 'https:' && referrer.host === 'docs.google.com' && referrer.pathname === '/') { if (job.guid) reconcile(job, 'EXPORT_REFERRER_UNVERIFIED'); return; }
      if (referrer.protocol !== 'https:' || referrer.host !== 'docs.google.com' || referrer.pathname !== `/videos/d/${job.documentId}/edit`) return;
    } catch { if (job.guid) reconcile(job, 'EXPORT_REFERRER_UNVERIFIED'); return; }
    if (job.downloadId !== null && job.downloadId !== item.id) { reconcile(job, 'AMBIGUOUS_DOWNLOAD_ID'); return; }
    // Chrome's download event carries the exact initiating document even when
    // Page download events are absent. Never infer it from a filename or origin.
    if (!job.guid && (foreignFrameUrls.has(item.url) || foreignFrameUrls.has(item.finalUrl))) return;
    if (!job.guid && item.mime !== 'video/mp4' && !/\.mp4$/i.test(item.filename || '')) return;
    job.downloadId = item.id;
    job.url ||= item.finalUrl || item.url;
    job.correlation = job.guid ? 'frame_and_document' : 'document_referrer';
    job.state = 'downloading';
  }
  function onCreated(item) {
    expire();
    if (![...jobs.values()].some(job => ['armed', 'downloading'].includes(job.state))) return;
    if (!Number.isInteger(item.id) || item.id < 0 || typeof item.url !== 'string' || item.url.length > 8192 || (item.finalUrl?.length || 0) > 8192 || (item.referrer?.length || 0) > 2048) return;
    const candidate = {id: item.id, url: item.url, finalUrl: item.finalUrl, referrer: item.referrer, startTime: item.startTime, mime: item.mime, filename: item.filename, observedAt: now()};
    // Only a short in-memory race buffer, never a download-history search or log.
    if (candidates.size >= 64 && !candidates.has(item.id)) {
      for (const job of jobs.values()) if (['armed', 'downloading'].includes(job.state)) reconcile(job, 'DOWNLOAD_EVENT_OVERFLOW');
      candidates.clear();
      return;
    }
    candidates.set(item.id, candidate);
    for (const job of jobs.values()) correlate(job, candidate);
  }
  function onChanged(delta) {
    for (const job of jobs.values()) {
      if (job.downloadId !== delta.id || job.state !== 'downloading') continue;
      if (delta.state?.current === 'interrupted' || delta.error?.current) reconcile(job, 'BROWSER_DOWNLOAD_INTERRUPTED');
    }
  }
  async function status(jobId, sessionId) {
    const job = lookup(jobId, sessionId);
    if (job.state === 'downloading' && job.downloadId !== null) {
      let records;
      try { records = await chromeApi.downloads.search({id: job.downloadId}); }
      catch { reconcile(job, 'DOWNLOAD_STATUS_UNAVAILABLE'); }
      // A revoke or conflicting event may have arrived while search waited.
      if (job.state === 'downloading' && records) {
        if (records.length !== 1 || records[0].id !== job.downloadId) reconcile(job, 'DOWNLOAD_RECORD_LOST');
        else {
          const item = records[0];
          if (item.url !== job.url && item.finalUrl !== job.url) reconcile(job, 'DOWNLOAD_ID_CHANGED');
          else if (item.state === 'interrupted' || item.error) reconcile(job, 'BROWSER_DOWNLOAD_INTERRUPTED');
          else if (item.state === 'complete' && (job.cdpCompleted || job.correlation === 'document_referrer')) {
            if (!mp4Path(item.filename)) reconcile(job, 'INVALID_EXPORT_PATH');
            else if (!item.exists) reconcile(job, 'EXPORT_FILE_MISSING');
            else { job.filename = item.filename; job.state = 'completed'; }
          }
        }
      }
    }
    return {jobId: job.jobId, sessionId: job.sessionId, documentId: job.documentId,
      ...(job.correlation === 'document_referrer' ? {attachmentFrameId: job.frameId} : {frameId: job.frameId}),
      state: job.state, triggerOutcome: job.triggerOutcome, ...(job.code ? {code: job.code} : {}),
      ...(job.guid ? {guid: job.guid} : {}), ...(job.correlation ? {correlation: job.correlation} : {}), ...(job.downloadId !== null ? {downloadId: job.downloadId} : {}),
      ...(job.state === 'completed' ? {filename: job.filename} : {})};
  }
  async function preflight(sessionId) {
    // Refresh only an ID previously observed for this exact document, never
    // enumerate download history. Preserve unresolved/ambiguous evidence.
    for (const job of jobs.values()) if (job.sessionId === sessionId && job.state === 'downloading' && job.downloadId !== null) await status(job.jobId, sessionId);
    return pending(sessionId);
  }
  function revoke(sessionId) {
    for (const job of jobs.values()) if (job.sessionId === sessionId) { job.state = 'revoked'; job.code = 'SESSION_REVOKED'; job.url = null; job.filename = null; }
  }
  function discard(jobId, sessionId) {
    const job = lookup(jobId, sessionId);
    if (job.state !== 'armed' || job.guid || job.downloadId !== null || job.triggerOutcome !== 'pending') return false;
    jobs.delete(jobId);
    return true;
  }
  function markTriggerAccepted(jobId) {
    const job = jobs.get(jobId);
    if (job && job.triggerOutcome !== 'unknown') job.triggerOutcome = 'performed';
  }
  function markTriggerUnknown(jobId) {
    const job = jobs.get(jobId);
    if (job) job.triggerOutcome = 'unknown';
  }
  const unsubscribe = subscribeDownloads(chromeApi.downloads, {onCreated, onChanged});
  function dispose() { unsubscribe(); jobs.clear(); candidates.clear(); foreignFrameUrls.clear(); }
  return {arm, onDebuggerEvent, status, pending, preflight, revoke, discard, markTriggerAccepted, markTriggerUnknown, dispose};
}
