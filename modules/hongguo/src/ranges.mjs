import { open } from 'node:fs/promises';
import { AppError } from './common.mjs';

export function byteRange(header, size) {
  if (!header) return { status: 200, start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const first = Number(match[1]), last = Number(match[2]);
  if (![first, last].every(Number.isSafeInteger)) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  if (start < 0 || start >= size || end < start) return null;
  return { status: 206, start, end };
}
export async function serveFile(req, res, entry, type = 'video/mp4') {
  let handle;
  try { handle = await open(entry.file, 'r'); } catch { throw new AppError('SESSION_EXPIRED', '媒体会话已过期，请重新选集', 410); }
  let handedOff = false;
  try {
    const size = (await handle.stat()).size;
    if (size !== entry.size) throw new AppError('MEDIA_CHANGED', '媒体文件已变化，请重新选集', 409);
    const range = byteRange(req.headers.range, size);
    const headers = { 'cache-control': 'no-store', 'content-type': type, 'accept-ranges': 'bytes' };
    if (!range) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': '0' }); res.end(); return; }
    headers['content-length'] = String(range.end - range.start + 1);
    if (range.status === 206) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
    res.writeHead(range.status, headers);
    // 客户端在打开文件期间已断开时 close 事件早已发出，下面的监听收不到：直接结束，由 finally 关文件
    if (req.method === 'HEAD' || res.destroyed) { res.end(); return; }
    const stream = handle.createReadStream({ start: range.start, end: range.end }); handedOff = true;
    res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
  } finally { if (!handedOff) await handle.close(); }
}
