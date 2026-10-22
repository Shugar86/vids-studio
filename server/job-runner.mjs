import {ExportJobs} from './jobs.mjs';
import {bridgeRequest} from './bridge-client.mjs';
import {PROFILE} from './runtime.mjs';

// Only one explicitly requested export/reconciliation is accepted per process.
// stdin EOF is expected. Parent/stdio loss never authorizes replay or takeover.
process.stdout.on('error', () => {});
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 256 * 1024) process.exit(1);
}
let jobs, heartbeat;
function reply(value) { try { process.stdout.end(`${JSON.stringify(value)}\n`); } catch { /* A missing receipt does not cancel a browser export. */ } }
try {
  const request = JSON.parse(raw); raw = '';
  if (!['start', 'status', 'cancel'].includes(request.method) || typeof request.directory !== 'string' || !request.args) throw new Error('Invalid runner request');
  jobs = new ExportJobs({directory: request.directory, bridgeRequest, profile: PROFILE});
  const beat = () => {
    for (const job of jobs.active.values()) {
      job.runner = {kind: 'detached', lastSeen: new Date().toISOString()};
      try { jobs.save(job); } catch { /* Ownership checks in each next step stop a superseded runner. */ }
    }
  };
  heartbeat = setInterval(beat, 5000); heartbeat.unref();
  const result = await jobs[request.method](request.args);
  beat();
  reply({ok: true, result});
  await jobs.drain();
} catch (error) {
  reply({ok: false, error: {code: error.code || 'JOB_RUNNER_ERROR', message: error.code ? error.message : 'The isolated export runner could not complete its request.'}});
} finally { clearInterval(heartbeat); jobs?.close(); }
