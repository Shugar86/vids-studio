import {open, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {jobError, privateDirectory} from './jobs-store.mjs';

async function command(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = ''; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(jobError('MEDIA_CHECK_TIMEOUT', `${binary} did not finish in time.`)); }, timeoutMs);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 1024 * 1024) { child.kill('SIGKILL'); finish(jobError('MEDIA_CHECK_LIMIT', 'Media metadata exceeds the limit.')); } });
    child.stderr.on('data', data => { if (stderr.length < 65536) stderr += data; });
    child.on('error', () => finish(jobError('MEDIA_TOOL_UNAVAILABLE', `${binary} is required; no tool was installed.`)));
    child.on('close', code => finish(code === 0 ? null : jobError('MEDIA_CHECK_FAILED', `${binary} could not verify this export.`), stdout));
  });
}
export async function verifyExport({source, outputDirectory, jobId, maxBytes = 2 * 1024 * 1024 * 1024}) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw jobError('INVALID_JOB_ID', 'Use an opaque job ID.');
  if (typeof source !== 'string' || !source.startsWith('/') || !/\.mp4$/i.test(source) || source.includes('\0')) throw jobError('INVALID_EXPORT_PATH', 'The correlated download must be an absolute MP4 path.');
  privateDirectory(outputDirectory);
  let input, output; const destination = join(outputDirectory, `${jobId}.mp4`); let created = false;
  try {
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await input.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) throw jobError('INVALID_EXPORT_FILE', 'Export must be a nonempty owned regular file within the size limit.');
    output = await open(destination, 'wx', 0o600); created = true;
    const hash = createHash('sha256'); let position = 0; const buffer = Buffer.alloc(1024 * 1024);
    while (position < before.size) {
      const {bytesRead} = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw jobError('EXPORT_FILE_CHANGED', 'Download changed while copying.');
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) { const result = await output.write(buffer, written, bytesRead - written, position + written); written += result.bytesWritten; }
      position += bytesRead;
    }
    const after = await input.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw jobError('EXPORT_FILE_CHANGED', 'Download changed while copying.');
    await output.sync(); await output.close(); output = null; await input.close(); input = null;
    const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,width,height,duration', '-of', 'json', destination], 30000));
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const duration = Number(probe.format?.duration);
    if (!video || !(video.width > 0 && video.height > 0 && duration > 0 && Number.isFinite(duration)) || !String(probe.format?.format_name).split(',').includes('mp4')) throw jobError('INVALID_EXPORT_MEDIA', 'The downloaded file is not a valid MP4 video.');
    await command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-i', destination, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-'], 180000);
    return {path: destination, sha256: hash.digest('hex'), bytes: before.size, durationSeconds: duration, width: video.width, height: video.height,
      streams: probe.streams.map(({index, codec_type, codec_name}) => ({index, type: codec_type, codec: codec_name})),
      verification: {container: 'verified', decode: 'verified', speechText: 'not_checked', sound: 'not_checked', motion: 'not_checked', captions: 'not_checked', viewerClarity: 'not_checked'}};
  } catch (error) { if (created) await unlink(destination).catch(() => {}); throw error; }
  finally { await input?.close().catch(() => {}); await output?.close().catch(() => {}); }
}
