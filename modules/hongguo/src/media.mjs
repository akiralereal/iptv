import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, mediaURL } from './common.mjs';
const run = promisify(execFile);

export function assessCompleteness({ expectedDuration, duration, decodedSeconds, audio, video, finished, errors }) {
  const tolerance = Math.max(1, Number(expectedDuration || duration) * 0.01);
  if (!audio || !video || !finished || errors || !Number.isFinite(duration) || duration <= 0 || Math.abs(decodedSeconds - duration) > tolerance) return 'decode_failed';
  if (!Number.isFinite(expectedDuration) || !(expectedDuration > 0)) return 'duration_unconfirmed';
  if (Math.abs(expectedDuration - duration) > tolerance) return 'duration_mismatch';
  return 'complete';
}
export async function inspectMedia(url, { local = false } = {}) {
  if (!local) mediaURL(url);
  let result;
  try {
    result = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-rw_timeout', '15000000', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,duration', '-of', 'json', url], { timeout: 35000, maxBuffer: 500000 });
  } catch { throw new AppError('MEDIA_UNREADABLE', '媒体无法解析或格式暂不支持'); }
  const data = JSON.parse(result.stdout);
  const video = data.streams?.find(s => s.codec_type === 'video'), audio = data.streams?.find(s => s.codec_type === 'audio');
  if (!video || !audio || !['h264', 'hevc'].includes(video.codec_name) || !(Number(data.format?.duration) > 0)) throw new AppError('UNSUPPORTED_MEDIA', '此集没有兼容的音视频轨道');
  return { duration: Number(data.format.duration), size: Number(data.format.size), video: video.codec_name, audio: audio.codec_name, width: video.width, height: video.height };
}
export async function decodeMedia(url, media, expectedDuration, { local = false } = {}) {
  let finished = false, decodedSeconds = 0, errors = false;
  try {
    const result = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-rw_timeout', '15000000', '-xerror', '-i', local ? url : mediaURL(url), '-map', '0:v:0', '-map', '0:a:0', '-progress', 'pipe:1', '-f', 'null', '-'], { timeout: 180000, maxBuffer: 2000000 });
    const times = [...result.stdout.matchAll(/out_time_us=(\d+)/g)];
    decodedSeconds = Number(times.at(-1)?.[1] || 0) / 1e6;
    finished = result.stdout.includes('progress=end'); errors = !!result.stderr.trim();
  } catch { errors = true; }
  return { classification: assessCompleteness({ expectedDuration, duration: media.duration, decodedSeconds, audio: !!media.audio, video: !!media.video, finished, errors }), decodedSeconds, finished, errors };
}
