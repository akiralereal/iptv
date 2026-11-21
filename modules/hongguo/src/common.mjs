export const ORIGIN = 'https://hongguoduanju.com';
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class AppError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}
// Keep identifiers above 2^53 exact. Recent Node releases expose the original
// JSON number spelling to the reviver; ordinary numeric values stay numbers.
export function parseJSON(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source) throw new AppError('JSON_PRECISION', '当前 Node.js 版本无法精确读取剧目标识');
      return context.source;
    }
    return value;
  });
}
export function id(value) {
  if (typeof value !== 'string' || !/^\d{1,24}$/.test(value)) throw new AppError('INVALID_ID', '剧目标识无效', 400);
  return value;
}
export function episodeNumber(value, total) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > total) throw new AppError('INVALID_EPISODE', '集号不在当前剧目目录中', 400);
  return number;
}
export function mediaURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('INVALID_MEDIA', '官网没有提供有效媒体地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !url.hostname.endsWith('.qznovelvod.com')) {
    throw new AppError('INVALID_MEDIA', '媒体地址不属于已验证的官方视频域名');
  }
  return url.href;
}
export function imageURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password && ['byteimg.com', 'douyinpic.com', 'fqnovelpic.com'].some(d => u.hostname.endsWith('.' + d))) return u.href;
  } catch {}
  return '';
}
export function parseRouter(html) {
  const found = /(?:window\.)?_ROUTER_DATA\s*=\s*/.exec(html);
  if (!found) throw new AppError('PAGE_CHANGED', '官网页面暂时没有返回可读取的数据');
  const start = found.index + found[0].length;
  let quoted = false, escaped = false, depth = 0;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (--depth === 0) {
        try { const value = JSON.parse(html.slice(start, i + 1)); if (value.loaderData) return value.loaderData; } catch {}
        break;
      }
    }
  }
  throw new AppError('PAGE_CHANGED', '官网页面数据结构已变化');
}
export async function boundedText(response, max = 6_000_000) {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new AppError('TOO_LARGE', '官网响应超过大小限制'); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > max) throw new AppError('TOO_LARGE', '官网响应超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function officialPage(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(ORIGIN + path, { headers: { 'user-agent': USER_AGENT, referer: ORIGIN + '/' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (r.status >= 500 && !attempt) { await r.body?.cancel(); continue; }
    if (!r.ok) { await r.body?.cancel(); throw new AppError('UPSTREAM', `官网页面暂不可用（${r.status}）`); }
    return parseRouter(await boundedText(r));
  }
}
export class Cache {
  values = new Map(); pending = new Map();
  constructor(limit = 100) { this.limit = limit; }
  get(key, ttl, loader) {
    const hit = this.values.get(key);
    if (hit?.until > Date.now()) return Promise.resolve(hit.value);
    if (this.pending.has(key)) return this.pending.get(key);
    const job = Promise.resolve().then(loader).then(value => {
      this.values.delete(key);
      while (this.values.size >= this.limit) this.values.delete(this.values.keys().next().value);
      this.values.set(key, { value, until: Date.now() + ttl });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, job); return job;
  }
}
