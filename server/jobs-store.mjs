import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, lstatSync, openSync, closeSync, chmodSync, unlinkSync} from 'node:fs';
import {join, resolve, parse} from 'node:path';
import {createHash, timingSafeEqual} from 'node:crypto';

export function jobError(code, message) { const error = new Error(message); error.code = code; return error; }
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function privateDirectory(directory) {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parent = lstatSync(current);
    const writableByOthers = parent.mode & 0o022;
    const stickyRoot = parent.uid === 0 && (parent.mode & 0o1000);
    if (!parent.isDirectory() || parent.isSymbolicLink() || ![0, process.getuid()].includes(parent.uid) || (writableByOthers && !stickyRoot)) throw jobError('UNSAFE_JOB_STORE', 'Job store ancestors must be trusted non-symlink directories.');
  }
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw jobError('UNSAFE_JOB_STORE', 'Jobs require an owned, non-symlink 0700 directory.');
  return absolute;
}
export class JobStore {
  constructor(directory, {now = Date.now, retentionMs = 7 * 86400000, maxJobs = 500} = {}) {
    this.directory = privateDirectory(directory); this.now = now; this.retentionMs = retentionMs; this.maxJobs = maxJobs;
    this.resultsDirectory = privateDirectory(join(this.directory, 'results'));
    const file = join(this.directory, 'jobs.sqlite');
    try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw jobError('UNSAFE_JOB_STORE', 'Job database must be an owned 0600 regular file.');
    this.file = file; this.fileIdentity = {dev: info.dev, ino: info.ino};
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, profile TEXT NOT NULL, document TEXT NOT NULL, intent TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(profile,intent));
      CREATE UNIQUE INDEX IF NOT EXISTS one_export_per_document ON jobs(profile,document) WHERE state IN ('queued','running','waiting','needs_reconciliation');`);
    chmodSync(file, 0o600);
  }
  assertSafe() {
    privateDirectory(this.directory); privateDirectory(this.resultsDirectory);
    const info = lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.dev !== this.fileIdentity.dev || info.ino !== this.fileIdentity.ino) throw jobError('UNSAFE_JOB_STORE', 'Persistent job storage changed identity or permissions.');
  }
  prune() {
    this.assertSafe();
    const expired = this.db.prepare("SELECT id,body FROM jobs WHERE updated < ? AND state IN ('succeeded','failed','cancelled')").all(this.now() - this.retentionMs);
    for (const row of expired) {
      const expected = join(this.resultsDirectory, `${row.id}.mp4`);
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(row.id);
      {
        try { const info = lstatSync(expected); if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid()) unlinkSync(expected); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  create(job) {
    this.prune();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
      if (count >= this.maxJobs) throw jobError('JOB_STORE_FULL', 'Job retention is full; archive completed results before creating another job.');
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(job.id, job.profileId, job.documentId, job.intentId, job.state, this.now(), JSON.stringify(job));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) throw jobError('JOB_ALREADY_EXISTS', 'This document has an unsettled export or this intent already has a job. Use its existing job capability; do not replay.');
      throw error;
    }
  }

  get(id) { this.assertSafe(); const row = this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; }
  authorized(id, token) {
    const job = this.get(id);
    const candidate = typeof token === 'string' ? tokenHash(token) : '';
    if (!job || candidate.length !== job.ownerHash.length || !timingSafeEqual(Buffer.from(candidate), Buffer.from(job.ownerHash))) throw jobError('JOB_NOT_FOUND', 'No job is available for that capability.');
    return job;
  }
  save(job) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(job.id);
      if (!previous || previous.instance !== job.instance || (previous.runnerEpoch || 0) !== (job.runnerEpoch || 0)) throw jobError('JOB_RUNNER_SUPERSEDED', 'A recovery owner took over this job; the previous runner stopped.');
      if (previous?.cancelRequested) { job.cancelRequested = true; if (!job.cancellation) job.cancellation = previous.cancellation; }
      job.updatedAt = new Date(this.now()).toISOString();
      this.db.prepare('UPDATE jobs SET state=?,updated=?,body=? WHERE id=?').run(job.state, this.now(), JSON.stringify(job), job.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  change(id, token, update) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.authorized(id, token);
      update(job);
      job.updatedAt = new Date(this.now()).toISOString();
      this.db.prepare('UPDATE jobs SET state=?,updated=?,body=? WHERE id=?').run(job.state, this.now(), JSON.stringify(job), job.id);
      this.db.exec('COMMIT');
      return job;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  requestCancel(id, token) {
    return this.change(id, token, job => {
      if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return;
      job.cancelRequested = true;
      job.cancellation = 'stopping_further_steps_not_confirmed_google_cancel';
    });
  }
  claimRecovery(id, token, instance, leaseHash) {
    return this.change(id, token, job => {
      if (['succeeded', 'failed', 'cancelled'].includes(job.state)) throw jobError('JOB_ALREADY_TERMINAL', 'This job has already finished.');
      job.instance = instance; job.leaseHash = leaseHash; job.runnerEpoch = (job.runnerEpoch || 0) + 1;
      job.state = 'needs_reconciliation'; job.stage = 'inspecting_previous_outcome';
    });
  }
  close() { this.db.close(); }
}
