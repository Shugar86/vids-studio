import {randomUUID, createHash} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {JobStore, jobError, tokenHash} from './jobs-store.mjs';
import {verifyExport} from './jobs-media.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const PUBLIC = ['schemaVersion', 'id', 'profileId', 'documentId', 'kind', 'intentId', 'intentFingerprint', 'state', 'stage', 'createdAt', 'updatedAt', 'operationIds', 'receipts', 'evidence', 'issue', 'cancelRequested', 'cancellation', 'result'];
const LABELS = [/^File$/, /^Download d ►$/, /^MP4 video \(\.mp4\) d$/];
function publicJob(job) { return Object.fromEntries(PUBLIC.filter(key => job[key] !== undefined).map(key => [key, job[key]])); }
function requireValue(value, code, message) { if (!value) throw jobError(code, message); }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value); }

export class ExportJobs {
  constructor({directory, bridgeRequest, profile, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), verify = verifyExport}) {
    this.profile = profile; this.bridge = bridgeRequest; this.now = now; this.wait = wait; this.verify = verify;
    this.store = new JobStore(directory, {now}); this.instance = randomUUID(); this.active = new Map(); this.tasks = new Map();
  }
  async call(method, args) {
    const response = await this.bridge(method, args);
    if (!response?.ok) { const error = jobError(response?.error?.code || 'BRIDGE_ERROR', response?.error?.message || 'Bridge did not return a valid response.'); error.outcome = response?.error?.outcome; throw error; }
    return response;
  }
  async start(args) {
    requireValue(args.kind === 'export_mp4' && validId(args.intentId) && validId(args.documentId), 'INVALID_ARGUMENT', 'Provide export_mp4 with stable intentId and observed documentId.');
    requireValue(typeof args.controlToken === 'string' && args.controlToken.length >= 32 && typeof args.sessionId === 'string', 'INVALID_ARGUMENT', 'Use the current session and this task’s control token.');
    requireValue(typeof args.jobId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.jobId) && typeof args.jobToken === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(args.jobToken), 'INVALID_ARGUMENT', 'Generate and retain jobId and a random 32-byte jobToken before sending start.');
    const intentFingerprint = createHash('sha256').update(JSON.stringify([this.profile.id, args.documentId, args.kind, args.intentId, args.sessionId, args.automaticDownload])).digest('hex');
    if (this.store.get(args.jobId)) {
      const existing = this.store.authorized(args.jobId, args.jobToken);
      requireValue(existing.intentFingerprint === intentFingerprint, 'JOB_INTENT_CONFLICT', 'An existing job ID must keep the same intent and arguments. No action was repeated.');
      return {...this.status({jobId: args.jobId, jobToken: args.jobToken}), jobToken: args.jobToken};
    }
    const check = args.automaticDownload;
    const checkedAt = Date.parse(check?.checkedAt);
    requireValue(check?.confirmed === true && typeof check.source === 'string' && check.source.trim().length >= 8 && check.source.length <= 256 && Number.isFinite(checkedAt) && checkedAt <= this.now() + 5000 && this.now() - checkedAt <= 900000,
      'AUTO_DOWNLOAD_PRECONDITION', 'Before export, attest that automatic saving without Save As was checked in this profile within 15 minutes. No browser setting was changed.');
    const status = (await this.call('status', {})).result;
    requireValue(status?.attached && status.sessionId === args.sessionId && status.documentId === args.documentId, 'DOCUMENT_CHANGED', 'The current attached document/session does not match the export request.');
    requireValue(status.control?.mode === 'write', 'CONTROL_RECONCILIATION_REQUIRED', 'Export requires a write lease, not a reconciliation lease.');
    requireValue(status.capabilities?.includes('export_trigger') && status.capabilities?.includes('export_download_status'), 'EXPORT_UNAVAILABLE', 'Reload the compatible extension with download observation before exporting.');
    await this.call('renew_control', {sessionId: args.sessionId, controlToken: args.controlToken});
    const jobToken = args.jobToken;
    const job = {schemaVersion: 1, id: args.jobId, profileId: this.profile.id, documentId: args.documentId, kind: 'export_mp4', intentId: args.intentId,
      intentFingerprint,
      ownerHash: tokenHash(jobToken), leaseHash: tokenHash(args.controlToken), instance: this.instance, sessionId: args.sessionId, automaticDownload: check,
      runnerEpoch: 0, state: 'queued', stage: 'queued', createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString(), operationIds: [], receipts: [], evidence: [], cancelRequested: false};
    this.store.create(job); this.active.set(job.id, job);
    const task = new Promise(resolve => setImmediate(resolve)).then(() => this.run(job, {sessionId: args.sessionId, controlToken: args.controlToken})).finally(() => {this.active.delete(job.id); this.tasks.delete(job.id);});
    this.tasks.set(job.id, task);
    return {...publicJob(job), jobToken};
  }
  save(job) {
    const stored = this.store.get(job.id);
    if (stored?.cancelRequested) job.cancelRequested = true;
    this.store.save(job);
  }
  syncCancellation(job) { if (this.store.get(job.id)?.cancelRequested) job.cancelRequested = true; return job.cancelRequested; }
  async release(job, auth) {
    try { const response = await this.call('release_control', auth); requireValue(response.result?.released === true, 'CONTROL_RELEASE_UNCONFIRMED', 'The native coordinator did not confirm lease release.'); job.evidence.push({kind: 'control_released', at: new Date(this.now()).toISOString()}); this.save(job); return true; }
    catch (error) { if (error.code === 'JOB_RUNNER_SUPERSEDED') throw error; job.evidence.push({kind: 'control_release_unconfirmed', code: error.code, at: new Date(this.now()).toISOString()}); }
    this.save(job); return false;
  }
  async observeNode(label, auth, job) {
    const end = this.now() + 7000; let attempts = 0;
    while (this.now() < end && attempts++ < 12) {
      if (this.syncCancellation(job)) return null;
      const snapshot = (await this.call('observe', {...auth, maxNodes: 1500})).result;
      const nodes = snapshot?.nodes?.filter(node => node.role === 'menuitem' && label.test(node.name || '')) || [];
      if (nodes.length === 1 && snapshot.snapshotId && nodes[0].ref) return {snapshotId: snapshot.snapshotId, nodeRef: nodes[0].ref};
      if (nodes.length > 1) throw jobError('EXPORT_UI_AMBIGUOUS', 'More than one observed export menu target matched.');
      await this.wait(Math.min(250 * attempts, 1000));
    }
    throw jobError('EXPORT_UI_UNSUPPORTED', 'The verified English export menu is not visible. Inspect this UI; no blind fallback was used.');
  }
  async mutate(job, auth, method, params) {
    const operation_id = randomUUID();
    job.operationIds.push(operation_id); job.stage = method === 'export_trigger' ? 'trigger_intent_saved' : 'menu_intent_saved';
    if (method === 'export_trigger') job.triggerSent = true;
    this.save(job); // durable intent before sending any browser mutation
    let response;
    try { response = await this.bridge(method, {...auth, ...params, operation_id}); }
    catch { response = {ok: false, error: {code: 'TRANSPORT_UNKNOWN', outcome: 'unknown'}}; }
    const outcome = response?.ok ? 'performed' : (response?.error?.outcome === 'not_performed' ? 'not_performed' : 'unknown');
    job.receipts.push({operationId: operation_id, method, outcome, code: response?.error?.code || null, at: new Date(this.now()).toISOString()});
    this.save(job);
    if (outcome !== 'performed' && !(method === 'export_trigger' && outcome === 'unknown')) {
      const error = jobError(response?.error?.code || 'MUTATION_UNKNOWN', 'The export step did not produce a confirmed result; it was not retried.'); error.outcome = outcome; throw error;
    }
    return outcome;
  }
  async run(job, auth) {
    try {
      if (this.syncCancellation(job)) { job.state = 'cancelled'; job.stage = 'canceled_before_start'; job.cancellation = 'queued_job_canceled'; this.save(job); await this.release(job, auth); return; }
      job.state = 'running'; job.stage = 'opening_file_menu'; this.save(job);
      for (let index = 0; index < LABELS.length; index++) {
        const target = await this.observeNode(LABELS[index], auth, job);
        if (!target || this.syncCancellation(job)) { job.state = 'cancelled'; job.stage = 'further_steps_stopped'; job.cancellation = 'no_export_trigger_sent'; this.save(job); await this.release(job, auth); return; }
        if (index < 2) await this.mutate(job, auth, 'click', target);
        else await this.mutate(job, auth, 'export_trigger', {...target, jobId: job.id, automaticDownloadConfirmed: true, downloadModeCheckedAt: job.automaticDownload.checkedAt});
      }
      job.state = 'waiting'; job.stage = 'waiting_for_correlated_download'; this.save(job);
      const deadline = this.now() + 600000; let attempt = 0; let download;
      while (this.now() < deadline && attempt < 180) {
        this.syncCancellation(job);
        if (job.cancelRequested) { job.cancellation = 'further_steps_stopped_download_not_canceled'; this.save(job); }
        try { download = (await this.call('export_download_status', {...auth, jobId: job.id})).result; }
        catch (error) { throw jobError(error.code, 'The export outcome needs reconciliation; no export action was repeated.'); }
        requireValue(download?.jobId === job.id && download.sessionId === auth.sessionId && download.documentId === job.documentId, 'EXPORT_BINDING_CHANGED', 'Download evidence does not match this job, document and session.');
        if (download.state === 'completed') break;
        if (!['armed', 'downloading'].includes(download.state)) throw jobError(download.code || 'EXPORT_NEEDS_RECONCILIATION', 'The download could not be uniquely attributed and completed.');
        await this.wait(Math.min(250 * 2 ** Math.min(attempt++, 4), 4000));
      }
      requireValue(download?.state === 'completed', 'EXPORT_WAIT_EXPIRED', 'The bounded export wait expired; inspect the document and existing download before taking another action.');
      await this.finishDownload(job, auth, download);
    } catch (error) {
      if (error.code === 'JOB_RUNNER_SUPERSEDED') return;
      job.state = (job.triggerSent && !job.evidence.some(item => item.kind === 'control_released')) || error.outcome === 'unknown' || ['EXPORT_UI_UNSUPPORTED', 'EXPORT_UI_AMBIGUOUS'].includes(error.code) ? 'needs_reconciliation' : 'failed';
      job.stage = 'stopped'; job.issue = {code: error.code || 'JOB_FAILED', message: error.message, noReplay: true}; this.save(job);
      // After an unknown mutation the native coordinator determines whether a
      // release is safe. Do not force it or erase its unknown receipt.
      if (error.outcome !== 'unknown' && !job.triggerSent) await this.release(job, auth);
    }
  }
  async finishDownload(job, auth, download) {
    requireValue(download?.jobId === job.id && download.sessionId === job.sessionId && download.documentId === job.documentId && download.state === 'completed', 'EXPORT_BINDING_CHANGED', 'The completed download must match this job, original session and document.');
    requireValue(typeof download.guid === 'string' && Number.isInteger(download.downloadId) && typeof download.filename === 'string', 'EXPORT_EVIDENCE_INCOMPLETE', 'The download lacks frame-correlated provenance.');
    job.evidence.push({kind: 'correlated_download', guid: download.guid, downloadId: download.downloadId, frameId: download.frameId, sessionId: download.sessionId, documentId: download.documentId, at: new Date(this.now()).toISOString()});
    job.stage = 'download_observed_complete'; this.save(job);
    const released = await this.release(job, auth);
    requireValue(released, 'CONTROL_RELEASE_UNCONFIRMED', 'Control release was not confirmed; local verification has not started.');
    if (this.syncCancellation(job)) { job.state = 'cancelled'; job.stage = 'download_completed_after_cancel'; job.cancellation = 'further_steps_stopped_google_export_not_canceled'; this.save(job); return; }
    job.state = 'running'; job.stage = 'verifying_local_file'; this.save(job);
    const result = await this.verify({source: download.filename, outputDirectory: this.store.resultsDirectory, jobId: job.id});
    job.result = {...result, provenance: {profileId: job.profileId, documentId: job.documentId, sessionId: job.sessionId, downloadId: download.downloadId, guid: download.guid, operationIds: [...job.operationIds]}};
    job.evidence.push({kind: 'local_file_verified', sha256: result.sha256, at: new Date(this.now()).toISOString()});
    if (this.syncCancellation(job)) {
      job.state = 'cancelled'; job.stage = 'verification_finished_after_cancel'; job.cancellation = 'local_result_retained_google_export_not_canceled';
    } else { job.state = 'succeeded'; job.stage = 'verified_file'; }
    this.save(job);
  }
  status({jobId, jobToken, inspectDownload}) {
    const job = this.store.authorized(jobId, jobToken);
    if (inspectDownload) return this.inspect({jobId, jobToken}, job, inspectDownload);
    if (!TERMINAL.has(job.state) && job.instance !== this.instance) return {...publicJob(job), state: 'needs_reconciliation', stage: 'runner_not_local', issue: {code: 'JOB_RUNNER_UNAVAILABLE', message: 'This process cannot establish whether the previous runner is still alive. No action is resumed or replayed.'}};
    return publicJob(job);
  }
  result(args) { const job = this.status(args); requireValue(job.state === 'succeeded' && job.result, 'JOB_RESULT_NOT_READY', 'No successfully completed result is available for this job.'); return {jobId: job.id, ...job.result}; }
  cancel({jobId, jobToken, acknowledgeUnknown}) {
    const stored = this.store.authorized(jobId, jobToken);
    if (acknowledgeUnknown) return this.acknowledge({jobId, jobToken}, stored, acknowledgeUnknown);
    return publicJob(this.store.requestCancel(jobId, jobToken));
  }
  async recoveryAuth(job, auth, {sameSession = false} = {}) {
    requireValue(typeof auth?.controlToken === 'string' && auth.controlToken.length >= 32 && typeof auth.sessionId === 'string', 'INVALID_ARGUMENT', 'Recovery requires this task’s current native writer lease.');
    requireValue(tokenHash(auth.controlToken) !== job.leaseHash, 'FRESH_RECOVERY_LEASE_REQUIRED', 'Release or reconcile the previous native lease, then acquire a new writer token before recovery. Reusing the old token cannot fence a delayed old request.');
    requireValue(!this.active.has(job.id), 'JOB_STILL_RUNNING', 'This process still runs the job; use normal status or cancellation.');
    const status = (await this.call('status', {})).result;
    requireValue(status?.attached && status.documentId === job.documentId && status.sessionId === auth.sessionId && (!sameSession || auth.sessionId === job.sessionId), 'DOCUMENT_CHANGED', 'Recovery must target the exact original document and requested session.');
    requireValue(status.control?.mode === 'write', 'CONTROL_RECONCILIATION_REQUIRED', 'Complete native reconciliation first and supply this task’s current writer lease.');
    await this.call('renew_control', {sessionId: auth.sessionId, controlToken: auth.controlToken});
    return {sessionId: auth.sessionId, controlToken: auth.controlToken};
  }
  async inspect(access, prior, request) {
    if (TERMINAL.has(prior.state)) return publicJob(prior);
    const auth = await this.recoveryAuth(prior, request, {sameSession: true});
    const job = this.store.claimRecovery(access.jobId, access.jobToken, this.instance, tokenHash(auth.controlToken));
    const initialEvidence = job.evidence.length;
    try {
      const download = (await this.call('export_download_status', {...auth, jobId: job.id})).result;
      requireValue(download?.jobId === job.id && download.sessionId === job.sessionId && download.documentId === job.documentId, 'EXPORT_BINDING_CHANGED', 'Previous download evidence does not match this job.');
      job.evidence.push({kind: 'recovery_observation', state: download.state, code: download.code || null, at: new Date(this.now()).toISOString()}); this.save(job);
      if (download.state === 'completed') await this.finishDownload(job, auth, download);
      else { job.state = 'needs_reconciliation'; job.stage = 'previous_download_unsettled'; this.save(job); }
    } catch (error) {
      if (error.code === 'JOB_RUNNER_SUPERSEDED') return this.status(access);
      job.state = 'needs_reconciliation'; job.stage = 'previous_download_unavailable';
      job.evidence.push({kind: 'recovery_observation_failed', code: error.code || 'JOB_ERROR', at: new Date(this.now()).toISOString()}); this.save(job);
    }
    // Recovery consumes only the lease explicitly supplied by this job owner.
    // If no file was verified it is still released; no action is replayed.
    if (!job.evidence.slice(initialEvidence).some(item => item.kind === 'control_released')) await this.release(job, auth);
    return publicJob(job);
  }
  async acknowledge(access, prior, request) {
    if (TERMINAL.has(prior.state)) return publicJob(prior);
    requireValue(typeof request.evidence === 'string' && request.evidence.trim().length >= 16 && request.evidence.length <= 1024, 'RECOVERY_EVIDENCE_REQUIRED', 'Record what was checked in the current document and existing downloads before abandoning this unresolved intent.');
    const auth = await this.recoveryAuth(prior, request);
    const job = this.store.claimRecovery(access.jobId, access.jobToken, this.instance, tokenHash(auth.controlToken));
    job.evidence.push({kind: 'operator_acknowledged_unknown', evidence: request.evidence.trim(), documentId: job.documentId, sessionId: auth.sessionId, at: new Date(this.now()).toISOString()}); this.save(job);
    requireValue(await this.release(job, auth), 'CONTROL_RELEASE_UNCONFIRMED', 'The recovery lease was not released; the intent remains unresolved.');
    job.cancelRequested = true; job.state = 'cancelled'; job.stage = 'unresolved_intent_abandoned'; job.cancellation = 'intent_abandoned_external_export_outcome_still_unknown'; this.save(job);
    return publicJob(job);
  }
  async drain() { await Promise.allSettled([...this.tasks.values()]); }
  close() { this.store.close(); }
}

export function registerJobTools(server, {z, bridgeRequest, PROFILE, directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'vids-studio-jobs', PROFILE.id)}) {
  let jobs;
  const service = () => jobs ||= new ExportJobs({directory, bridgeRequest, profile: PROFILE});
  const access = {jobId: z.string().uuid(), jobToken: z.string().min(32).max(128)};
  const definitions = {
    start: {jobId: z.string().uuid(), jobToken: z.string().min(32).max(128), kind: z.literal('export_mp4'), intentId: z.string().uuid(), documentId: z.string().min(8).max(128), sessionId: z.string().min(1).max(128), controlToken: z.string().min(32).max(128), automaticDownload: z.object({confirmed: z.literal(true), checkedAt: z.string().datetime(), source: z.string().min(8).max(256)}).strict()},
    status: {...access, inspectDownload: z.object({sessionId: z.string().min(1).max(128), controlToken: z.string().min(32).max(128)}).strict().optional()}, result: access,
    cancel: {...access, acknowledgeUnknown: z.object({sessionId: z.string().min(1).max(128), controlToken: z.string().min(32).max(128), evidence: z.string().min(16).max(1024)}).strict().optional()},
  };
  const descriptions = {
    start: 'Start one typed export_mp4 job for the currently attached Google Vids document with this task’s write lease. Requires a fresh explicit attestation that this profile automatically saves downloads without a system Save As dialog. Uses observed English File/Download/MP4 menu targets, not guessed clicks. Generate a UUID jobId and random 32-byte base64url jobToken and retain both before calling. Repeating identical arguments with that capability only returns the existing status. Never replay an unknown intent.',
    status: 'Read only this job’s durable stages, immutable action outcomes and later evidence using its jobToken. Optional inspectDownload accepts and consumes only this owner’s newly acquired writer lease for the original session/document, observes the existing watch once, and may verify an already-completed file after releasing the lease. It never replays an action.',
    result: 'Return the job’s verified local MP4 path, SHA-256, actual duration/dimensions/streams and download provenance. Technical verification does not claim listening, movement review or subtitle accuracy.',
    cancel: 'Request stopping only this job’s further steps. Queued jobs can be canceled; an already-sent Google export or browser download is not canceled by this request. Optional acknowledgeUnknown requires this owner’s newly acquired writer lease for the exact document plus explicit checked evidence; it abandons the old intent without claiming the external export was canceled. Only a new intent may then start.',
  };
  for (const [name, schema] of Object.entries(definitions)) server.registerTool(`vids_job_${name}`, {description: descriptions[name], inputSchema: schema, annotations: {readOnlyHint: name === 'result', destructiveHint: name === 'start', idempotentHint: name !== 'start', openWorldHint: name === 'start'}}, async args => {
    try { return {content: [{type: 'text', text: JSON.stringify(await service()[name](args), null, 2)}]}; }
    catch (error) { return {isError: true, content: [{type: 'text', text: JSON.stringify({error: {code: error.code || 'JOB_ERROR', message: error.message}}, null, 2)}]}; }
  });
  return {close: () => jobs?.close(), drain: async () => jobs?.drain()};
}
