# Experimental export jobs

[English](jobs.md) · [Русский](../ru/jobs.md) · [Home](../../README.md)

**Status:** implemented and tested with isolated browser fixtures; live Google Vids export acceptance is still pending. Use current tool schemas for exact arguments.

The first recipe is `export_mp4`. It uses the attached Vids document, an explicitly
supplied writer lease, fresh accessibility snapshots, and the observed English
menu `File` → `Download d ►` → `MP4 video (.mp4) d`. It does not guess translated
labels, run user-provided JavaScript, or repeat an uncertain click.

## Preconditions and capability

Node 22.13.0 or later, `ffprobe`, and `ffmpeg` are required. The extension needs
`downloads` permission and the internal `export_trigger` and
`export_download_status` capabilities. Reload the installed extension and
reconnect the client before testing an updated build.

Before `vids_job_start`, generate and securely retain a UUID `jobId`, UUID
`intentId`, and a random 32-byte base64url `jobToken`. Retain these **before sending
start**, so a lost response does not lose access. Supply the observed
`documentId`, `sessionId`, this task's current `controlToken`, and:

```json
{"kind":"export_mp4","automaticDownload":{"confirmed":true,"checkedAt":"<ISO timestamp>","source":"<how automatic saving in this profile was checked>"}}
```

`confirmed` is a user/operator attestation that downloads save automatically
without a system Save As dialog in this profile. It has no default. The timestamp
must be at most 15 minutes old and no more than five seconds in the future; the
driver checks it again immediately before the final click. The recipe never
changes browser download settings or opens/operates a system picker. Without the
attestation it stops before browser work. The caller must not invent it.

The caller grants the job use of its supplied writer lease through the browser
steps. The job releases that lease before copying or probing local media. Ordinary
status/download observations refresh native lease activity during the bounded
wait. Another task's capability is never acquired or released.

Identical repeated start arguments with the same `jobId` and `jobToken` return
existing status without browser calls. A changed intent or document is rejected;
a second ID for the same intent is rejected. Job status/result/cancel require the
job capability. Raw job/control capabilities are not stored; only their hashes
are persisted. Keep capabilities out of logs and shared artifacts.

## State and completion evidence

| State | Meaning |
| --- | --- |
| `queued` | Durable intent saved; browser recipe has not begun. |
| `running` | Observing menus, dispatching a guarded step, or verifying a local file. |
| `waiting` | The trigger was sent; bounded download observation is in progress. |
| `succeeded` | A correlated complete download was copied, hashed, probed, and decoded. |
| `failed` | A known failure, including invalid media after browser completion. |
| `cancelled` | Further job work stopped; the `cancellation` field states what happened externally. |
| `needs_reconciliation` | Unknown action, unsupported/ambiguous UI or download evidence, missing watcher/session, or unavailable previous runner. |

Each mutation gets a durable `operationId` before dispatch and an immutable
initial receipt (`performed`, `not_performed`, or `unknown`). Late observations
append evidence; they do not rewrite an unknown receipt. An unknown export click
may still lead to success **only after separate correlated completion and local
verification evidence**. It is never clicked again.

Each menu target is freshly observed with an exact role/name match. Observation
is bounded to seven seconds and 12 attempts per menu. Download observation has
250–4000 ms backoff, at most ten minutes/180 reads. Native errors, unsupported
locales, or ambiguous evidence stop the recipe. Successful envelope receipt alone
is insufficient: native release must explicitly report `released: true`.

`vids_job_result` returns the private copied MP4 path, SHA-256, byte count, actual
duration, dimensions, stream types/codecs, profile/document/session/download/GUID
provenance, and operation IDs. The source download remains intact. Input is an
owned, nonempty regular MP4 file, opened without following a final symlink, capped
at 2 GiB. Copying detects changes to source size/mtime/inode. The private copy is
then checked by ffprobe and fully decoded by ffmpeg with bounded process time
and a `file,pipe` protocol allowlist that excludes network media references.
Technical verification marks speech text, sound, motion, captions and viewer
clarity `not_checked`; it does not claim audiovisual review.

## Download attribution and verified limits

The watcher arms before the guarded export click. It binds the exact attached
session/tab/frame/document, then joins `Page.downloadWillBegin` GUID and URL to
`chrome.downloads.onCreated` using an exact URL or final redirect URL, creation
time, and full Vids document referrer. Only that matched numeric download ID is
queried with `downloads.search({id})`. No broad history search, newest-file scan,
filename guess, or URL fetch is used. Temporary URL/referrer metadata stays
inside the bounded watcher and is not returned in job output.

Both the Page GUID and the browser download must complete before a file path is
returned. Multiple matching GUIDs or IDs, revocation, interruption, missing files,
and unexpected file types fail closed. Missing or origin-only document referrer
stops immediately with `EXPORT_REFERRER_UNVERIFIED`. This is an unsupported
attribution case, not permission to accept a nearby download. An onCreated race
buffer is capped at 64 records/10 seconds; watches are capped at 32 and expire.

The real isolated Chromium integration test loads the **actual watcher** in a
small MV3 extension, with a disposable profile and locally served HTTP, redirect
and blob fixtures. The fake document explicitly uses `referrer=unsafe-url` to
provide full document referrers. The disposable profile is configured for
automatic saving; no `Page.setDownloadBehavior`/`Browser.setDownloadBehavior`
override is issued. It checks real GUID/download-ID/path correlation without
contacting Google or touching the user's Chrome profile. This proves the browser
mechanism **under those conditions**, not the current Google Vids export response.

**Live Google Vids export acceptance is pending extension reload and an authorized
export smoke test.** Google may use empty/origin-only referrers, a new download
route, another UI language, or different event behavior; those cases stop for
reconciliation. The Page download events are deprecated CDP events, so future
Chrome compatibility also needs validation. The independently observed live
English menu establishes only menu labels; it did not trigger an export.

There is no direct Chrome API field mapping a Page GUID to a DownloadItem ID.
The join therefore cannot guarantee unique attribution if another tab of the
**same document** concurrently downloads the **same exact URL** with the same full
referrer before its conflicting event is observed. Do not run manual/other-tab
exports concurrently with this recipe. Observed ambiguity is rejected; this
limitation is not concealed by a success claim or a settings override.

## Cancellation and recovery

`vids_job_cancel({jobId, jobToken})` atomically requests cancellation from the
latest stored state. A queued job releases its supplied lease without clicking.
Once an export has been sent, cancel means stop further steps, not cancel Google
rendering or the browser transfer. The runner continues bounded read-only outcome
observation; an unknown result stays unresolved. Cancellation during local
verification yields `cancelled` with the completed local result/evidence retained
in status, not a silent `succeeded` result.

A restart never resumes or replays work. Ordinary `vids_job_status` is read-only;
a nonlocal unfinished runner is reported as `needs_reconciliation`, because
process identity alone cannot prove it stopped. The job ID and secret capability
retained before start remain usable after a lost response or restart.

Recovery requires a **new native writer token**, different from the hash retained
for the previous runner. First inspect/reconcile the old native outcome, release
that lease, and acquire a fresh writer lease for the exact document. Merely reusing
the previous token is rejected. This native capability change fences a delayed
old socket dispatch; a durable runner epoch separately fences stale DB updates.
The job owner explicitly supplies the fresh token, and recovery consumes/releases
only that token.

* `vids_job_status` may include
  `inspectDownload: {sessionId, controlToken}`. The session must be the original
  watched session, with a fresh writer lease for the same document. It observes
  the surviving watch once. A completed file may be verified after release;
  otherwise new evidence records why the outcome remains unresolved. No UI
  action is repeated. Repeating recovery needs another freshly acquired lease.
* If the watcher is lost or the previous result cannot be established, inspect
  the current document and existing downloads, complete native reconciliation,
  then call `vids_job_cancel` with
  `acknowledgeUnknown: {sessionId, controlToken, evidence}`. A fresh writer lease
  for the exact original document and an explicit description of what was checked
  are required. This abandons the old **intent** and releases its reservation;
  the original unknown receipts remain. It does not claim the external export
  was canceled or failed. Any subsequent export requires a new explicit intent
  and ID, never a replay of the abandoned one.

## Storage and checks

The default store is
`$XDG_STATE_HOME/vids-studio-jobs/<profile>/jobs.sqlite` (or
`~/.local/state/vids-studio-jobs/<profile>/jobs.sqlite`). Construction is lazy:
an unsafe/unavailable store affects only job calls, not diagnostics or control.
Ancestors and database identity/permissions are checked, directories are 0700,
and the database/results are 0600 owned regular files. SQLite transactions and
FULL synchronization protect updates. One unsettled job reserves a document per
profile; the native coordinator additionally arbitrates document control across
profiles. Local verification holds no browser lease.

The store is capped at 500 jobs. Terminal records and their private copies are
pruned after seven days on the next start; unresolved records are never evicted
to bypass a reservation. Retain needed results elsewhere before expiry. Explicit
recovery can settle an unresolved record without inventing an external outcome.

Run `node --test tests/jobs.test.mjs tests/export-watch.test.mjs`. Tests include
real small MP4 probe/decode, a real isolated Chromium watcher, reversed download
event order, redirects/blob, foreign/missing referrer, ambiguity/revocation,
unknown receipts, caller-retained lost-response recovery, fresh lease fencing,
atomic cross-process cancellation, cancellation during verification, unsafe
stores/media, bounded waits, and no browser replay.
