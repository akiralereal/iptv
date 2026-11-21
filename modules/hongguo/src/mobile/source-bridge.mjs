import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appMediaURL } from './model.mjs';
import { APP_UA } from './session.mjs';

export const MAX_SOURCE = 200_000_000;

// FFmpeg gets a short-lived loopback capability. Only this bridge contacts the
// allowlisted CDN, so redirects and oversized responses cannot escape our checks.
export class SourceBridge {
  sources = new Map();
  constructor(fetcher = fetch) { this.fetcher = fetcher; }
  async start() {
    if (!this.started) this.started = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.serve(req, res));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(); });
    });
    await this.started;
  }
  async register(source) {
    await this.start();
    const token = randomBytes(24).toString('hex');
    const record = { url: appMediaURL(source.url), bytes: 0, size: 0, maxRangeStart: 0, requests: new Set(), released: false };
    this.sources.set(token, record);
    return { url: `http://127.0.0.1:${this.port}/${token}`, record, release: () => {
      record.released = true; this.sources.delete(token); for (const controller of record.requests) controller.abort();
    } };
  }
  async serve(req, res) {
    const source = this.sources.get(req.url?.slice(1));
    if (req.headers.host !== `127.0.0.1:${this.port}` || req.headers.origin || !['GET', 'HEAD'].includes(req.method) || !source || source.released) { res.writeHead(404); res.end(); return; }
    const range = req.headers.range;
    if (range && (range.length > 70 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) { res.writeHead(416); res.end(); return; }
    source.maxRangeStart = Math.max(source.maxRangeStart, Number(/^bytes=(\d+)-/.exec(range || '')?.[1] || 0));
    const controller = new AbortController(); source.requests.add(controller); res.once('close', () => controller.abort());
    try {
      const response = await this.fetcher(source.url, { method: req.method, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        headers: { 'user-agent': APP_UA, ...(range ? { range } : {}) } });
      const total = Number(response.headers.get('content-range')?.split('/')[1] || response.headers.get('content-length'));
      if (![200, 206].includes(response.status) || (total && (!Number.isSafeInteger(total) || total > MAX_SOURCE))) { await response.body?.cancel(); throw new Error('Invalid upstream media'); }
      if (source.size && total && source.size !== total) { await response.body?.cancel(); throw new Error('Upstream media changed'); }
      if (total) source.size = total;
      const headers = { 'content-type': 'video/mp4', 'cache-control': 'no-store' };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(name)) headers[name] = response.headers.get(name);
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); return; }
      let received = 0;
      const limiter = new Transform({ transform(chunk, encoding, done) {
        received += chunk.length; source.bytes += chunk.length;
        done(received > MAX_SOURCE || source.bytes > MAX_SOURCE * 3 ? new Error('Input limit exceeded') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, res);
    } catch { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); } }
    finally { source.requests.delete(controller); }
  }
  async close() {
    for (const source of this.sources.values()) for (const controller of source.requests) controller.abort();
    this.sources.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  }
}
