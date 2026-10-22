import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ExportJobs, publicJob} from './jobs.mjs';
import {jobError} from './jobs-store.mjs';

const entry = fileURLToPath(new URL('./job-runner.mjs', import.meta.url));
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

// A runner receives capabilities through a private anonymous pipe, never argv,
// files or logs. Closing the MCP client does not kill an already-started export.
export function runDetachedJob(request, {env = process.env, timeoutMs = 28000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
    let buffer = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy(); child.unref();
      error ? reject(error) : resolve(result);
    };
    const uncertain = () => jobError('JOB_RUNNER_RECEIPT_MISSING', 'No runner receipt arrived. The job may already exist: inspect the same jobId with its jobToken. No export was automatically repeated.');
    const timer = setTimeout(() => finish(uncertain()), timeoutMs);
    child.on('error', () => finish(jobError('JOB_RUNNER_UNAVAILABLE', 'Could not start the isolated export runner.')));
    child.stdin.on('error', () => finish(uncertain()));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return finish(uncertain());
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.ok === true) finish(null, response.result);
        else finish(jobError(response.error?.code || 'JOB_RUNNER_ERROR', response.error?.message || 'The isolated runner stopped without confirmed completion.'));
      } catch { finish(uncertain()); }
    });
    child.stdout.on('end', () => { if (!settled) finish(uncertain()); });
    child.stdin.end(JSON.stringify(request));
  });
}

export class DetachedExportJobs {
  constructor(options) { this.options = options; this.local = new ExportJobs(options); }
  async start(args) {
    if (this.local.store.get(args.jobId)) {
      // Existing start validates the immutable fingerprint before returning;
      // it cannot replay an action for an already persisted intent.
      await this.local.start(args);
      return {...this.status({jobId: args.jobId, jobToken: args.jobToken}), jobToken: args.jobToken};
    }
    return runDetachedJob({method: 'start', args, directory: this.options.directory});
  }
  status(args) {
    const job = this.local.store.authorized(args.jobId, args.jobToken);
    if (args.inspectDownload) return runDetachedJob({method: 'status', args, directory: this.options.directory});
    if (TERMINAL.has(job.state)) return publicJob(job);
    const seen = Date.parse(job.runner?.lastSeen);
    if (job.runner?.kind === 'detached' && Number.isFinite(seen) && Date.now() - seen >= -5000 && Date.now() - seen < 20000) {
      return {...publicJob(job), runner: {...job.runner, freshness: 'recent_heartbeat', observedAt: new Date().toISOString()}};
    }
    return {...publicJob(job), state: 'needs_reconciliation', stage: 'runner_unconfirmed',
      issue: {code: 'JOB_RUNNER_UNAVAILABLE', message: 'No recent runner heartbeat is available. The previous export may still exist; no browser action was repeated.'}};
  }
  result(args) {
    const job = this.status(args);
    if (job.state !== 'succeeded' || !job.result) throw jobError('JOB_RESULT_NOT_READY', 'No successfully completed result is available for this job.');
    return {jobId: job.id, ...job.result};
  }
  cancel(args) {
    this.local.store.authorized(args.jobId, args.jobToken);
    if (args.acknowledgeUnknown) return runDetachedJob({method: 'cancel', args, directory: this.options.directory});
    return publicJob(this.local.store.requestCancel(args.jobId, args.jobToken));
  }
  async drain() { await this.local.drain(); }
  close() { this.local.close(); }
}
