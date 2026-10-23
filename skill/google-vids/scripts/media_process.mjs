import {spawn} from 'node:child_process'

const failure = (code, message) => Object.assign(new Error(message), {code})

// One direct encoder process, never a shell. Resolve/reject only after 'close':
// callers may then release their media permit without leaving work behind.
export function runMediaProcess(command, args, {signal, timeoutMs = 600000, killGraceMs = 1000,
  stderrLimit = 65536, env = process.env} = {}) {
  if (![timeoutMs, killGraceMs, stderrLimit].every(value => Number.isSafeInteger(value) && value > 0))
    return Promise.reject(failure('INVALID_ARGUMENT', 'Media process limits must be positive integers.'))
  if (signal?.aborted) return Promise.reject(failure('MEDIA_CHECK_CANCELED', 'Local media work was canceled before encoding.'))
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(command, args, {env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true}) }
    catch { reject(failure('MEDIA_PROCESS_FAILED', 'Could not start the media encoder.')); return }
    let stderr = Buffer.alloc(0), error, killTimer, closed = false
    const stop = reason => {
      if (closed || error) return
      error = reason
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL') }, killGraceMs)
    }
    const abort = () => stop(failure('MEDIA_CHECK_CANCELED', 'Local media encoding stopped after cancellation or loss of its keeper.'))
    const timeout = setTimeout(() => stop(failure('MEDIA_PROCESS_TIMEOUT', 'Local media encoding exceeded its time limit.')), timeoutMs)
    signal?.addEventListener('abort', abort, {once: true})
    if (signal?.aborted) abort()
    child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-stderrLimit) })
    child.on('error', () => { error ||= failure('MEDIA_PROCESS_FAILED', 'Could not run the media encoder.'); })
    child.once('close', (code, exitSignal) => {
      closed = true
      clearTimeout(timeout); clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else if (code !== 0) reject(failure('MEDIA_PROCESS_FAILED',
        `Media encoder stopped (${exitSignal || code}): ${stderr.toString('utf8').slice(-400) || 'no diagnostic'}`))
      else resolve({code, stderr: stderr.toString('utf8')})
    })
  })
}
