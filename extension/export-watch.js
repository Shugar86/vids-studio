// Observe downloads caused by the already-attached frame. This module never
// starts a download, changes browser settings, or searches download history.
const TTL = 15 * 60 * 1000;
const LIMIT = 32;

function fault(code, message) { const error = new Error(message); error.code = code; throw error; }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function mp4Path(value) { return typeof value === 'string' && value.startsWith('/') && /\.mp4$/i.test(value) && !value.includes('\0'); }

export function createExportWatcher(chromeApi, {now = Date.now} = {}) {
  const jobs = new Map();
  const candidates = new Map();
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
  function arm(binding) {
    expire();
    if (!chromeApi.downloads?.onCreated || !chromeApi.downloads?.search) fault('EXPORT_UNAVAILABLE', 'The loaded extension does not provide download observation.');
    if (!binding || !['jobId', 'sessionId', 'frameId', 'documentId'].every(key => validId(binding[key])) || !Number.isInteger(binding.tabId)) fault('INVALID_ARGUMENT', 'Export binding is invalid.');
    if (jobs.has(binding.jobId)) fault('EXPORT_WATCH_EXISTS', 'An export watch cannot be armed a second time.');
    if (jobs.size >= LIMIT) fault('EXPORT_WATCH_CAPACITY', 'Export watch retention is full; wait for expiry.');
    if ([...jobs.values()].some(job => job.sessionId === binding.sessionId && ['armed', 'downloading'].includes(job.state))) fault('EXPORT_WATCH_BUSY', 'This session already has an export watch.');
    jobs.set(binding.jobId, {...binding, started: now(), state: 'armed', triggerOutcome: 'pending', guid: null, url: null, downloadId: null, filename: null});
    return {jobId: binding.jobId, state: 'armed'};
  }
  function onDebuggerEvent(source, method, params = {}) {
    if (source.sessionId) return;
    expire();
    for (const job of jobs.values()) {
      if (source.tabId !== job.tabId || !['armed', 'downloading', 'completed'].includes(job.state)) continue;
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
    if (!job.url || !['downloading', 'completed'].includes(job.state)) return;
    if (item.url !== job.url && item.finalUrl !== job.url) return;
    const started = Date.parse(item.startTime);
    if (!Number.isFinite(started) || started < job.started || started > now() + 1000) return;
    // Empty/origin-only referrers cannot distinguish a same-URL download in
    // another tab. Fail closed; the isolated HTTP/redirect/blob probe supplies
    // the full initiating document in all three verified cases.
    try {
      const referrer = new URL(item.referrer);
      if (referrer.protocol === 'https:' && referrer.host === 'docs.google.com' && referrer.pathname === '/') { reconcile(job, 'EXPORT_REFERRER_UNVERIFIED'); return; }
      if (referrer.protocol !== 'https:' || referrer.host !== 'docs.google.com' || referrer.pathname !== `/videos/d/${job.documentId}/edit`) return;
    } catch { reconcile(job, 'EXPORT_REFERRER_UNVERIFIED'); return; }
    if (job.downloadId !== null && job.downloadId !== item.id) { reconcile(job, 'AMBIGUOUS_DOWNLOAD_ID'); return; }
    job.downloadId = item.id;
  }
  function onCreated(item) {
    expire();
    if (![...jobs.values()].some(job => ['armed', 'downloading', 'completed'].includes(job.state))) return;
    if (!Number.isInteger(item.id) || item.id < 0 || typeof item.url !== 'string' || item.url.length > 8192 || (item.finalUrl?.length || 0) > 8192 || (item.referrer?.length || 0) > 2048) return;
    const candidate = {id: item.id, url: item.url, finalUrl: item.finalUrl, referrer: item.referrer, startTime: item.startTime, observedAt: now()};
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
      if (job.downloadId !== delta.id || !['downloading', 'completed'].includes(job.state)) continue;
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
          else if (item.state === 'complete' && job.cdpCompleted) {
            if (!mp4Path(item.filename)) reconcile(job, 'INVALID_EXPORT_PATH');
            else if (!item.exists) reconcile(job, 'EXPORT_FILE_MISSING');
            else { job.filename = item.filename; job.state = 'completed'; }
          }
        }
      }
    }
    return {jobId: job.jobId, sessionId: job.sessionId, documentId: job.documentId, frameId: job.frameId,
      state: job.state, triggerOutcome: job.triggerOutcome, ...(job.code ? {code: job.code} : {}),
      ...(job.guid ? {guid: job.guid} : {}), ...(job.downloadId !== null ? {downloadId: job.downloadId} : {}),
      ...(job.state === 'completed' ? {filename: job.filename} : {})};
  }
  function revoke(sessionId) {
    for (const job of jobs.values()) if (job.sessionId === sessionId) { job.state = 'revoked'; job.code = 'SESSION_REVOKED'; job.url = null; job.filename = null; }
  }
  function discard(jobId, sessionId) {
    const job = lookup(jobId, sessionId);
    if (job.state !== 'armed' || job.guid || job.downloadId !== null || job.triggerOutcome === 'unknown') return false;
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
  chromeApi.downloads?.onCreated?.addListener(onCreated);
  chromeApi.downloads?.onChanged?.addListener(onChanged);
  return {arm, onDebuggerEvent, status, revoke, discard, markTriggerAccepted, markTriggerUnknown};
}
