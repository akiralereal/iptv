import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { serveFile } from './ranges.mjs';
import { OfficialBrowser } from './browser.mjs';
import { Catalog } from './catalog.mjs';
import { Playback } from './playback.mjs';
import { AppError, ORIGIN, USER_AGENT } from './common.mjs';
import { MobileCatalog } from './mobile/catalog.mjs';
import { Account } from './mobile/account.mjs';
import { AccountActions } from './mobile/account-actions.mjs';
import { AccountSync } from './mobile/account-sync.mjs';
import { PlaybackCatalog } from './playback-catalog.mjs';
import { HongguoDanmaku } from './danmaku.mjs';
import { createMediaServer, isEmbyPath, playbackPassword } from './media-server.mjs';

function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req, limit = 4096) {
  const mimeType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (mimeType !== 'application/json') throw new AppError('CONTENT_TYPE', '请使用 JSON 请求', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new AppError('BODY_TOO_LARGE', '请求内容过大', 413);
    }
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch {}
  throw new AppError('BAD_JSON', '请求格式无效', 400);
}
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'application/javascript']], ['/style.css', ['style.css', 'text/css']]]);
export function createHongguo(root) {
  const browser = new OfficialBrowser();
  const catalog = new Catalog();
  const playback = new Playback(catalog, browser, root);
  const appCatalog = new MobileCatalog(playback.mobile.models.session);
  const account = new Account(root, playback.mobile.models.session);
  const accountActions = new AccountActions(account, catalog, playback);
  const accountSync = new AccountSync(account, accountActions, catalog);
  const publications = new PlaybackCatalog(root, catalog);
  const danmaku = new HongguoDanmaku({ catalog, playback, session: playback.mobile.models.session });
  const mediaServer = createMediaServer({
    catalog: publications, playback, danmaku, serveMedia: (req, res, entry) => serveMedia(req, res, entry, playback), body, json,
    serveGrowing: (req, res, entry, keepAlive) => serveGrowingMP4(req, res, playback, entry, keepAlive),
    serveHLS: (req, res, entry, name, token, playSessionId) => serveHLS(req, res, playback, entry, name, token, playSessionId),
  });

  async function handle(req, res, pathname, { adminPath, accessPrefix, isEmby = isEmbyPath(pathname), embyPort }) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: https://*.byteimg.com https://*.douyinpic.com https://*.fqnovelpic.com; style-src 'self'; script-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const queryStart = req.url.indexOf('?');
      const params = new URLSearchParams(queryStart === -1 ? '' : req.url.slice(queryStart + 1));
      if (isEmby) {
        await mediaServer(req, res, pathname, params);
        return;
      }
      if (pathname === '/api/playback-catalog' && ['GET', 'POST'].includes(req.method)) {
        let state;
        if (req.method === 'GET') state = await publications.ensure();
        else {
          const input = await body(req);
          if (Object.hasOwn(input, 'directPort')) {
            if (!embyPort) throw new AppError('EMBY_PORT_UNAVAILABLE', '红果 Emby 端口正在初始化，请稍后重试。');
            state = await publications.ensure();
            await embyPort.set(input.directPort);
          } else {
            state = input.rotate === true ? await publications.rotate() : await publications.set(input.seriesId, input.published);
          }
          if (!state.key || !state.serverId) state = await publications.ensure();
        }
        const prefixDepth = accessPrefix.split('/').filter(Boolean).length;
        const server = '../'.repeat(prefixDepth + 1) + 'hongguo';
        const portSettings = embyPort?.status();
        json(res, 200, {
          emby: { server, username: 'hongguo', password: playbackPassword(state.key), directPort: portSettings?.listeningPort, portSettings },
          series: state.series,
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/catalog/categories') { json(res, 200, await appCatalog.categories()); return; }
      if (req.method === 'GET' && pathname === '/api/catalog/page') { json(res, 200, await appCatalog.page(Object.fromEntries(params))); return; }
      if (req.method === 'GET' && pathname === '/api/search') { json(res, 200, await appCatalog.search({ query: params.get('q'), filters: params.get('filters') || '', cursor: params.get('cursor') || '' })); return; }
      if (req.method === 'GET' && pathname === '/api/account') { json(res, 200, await account.status()); return; }
      if (req.method === 'GET' && pathname === '/api/account/list') { json(res, 200, await account.list(params.get('kind'), params.get('cursor') || '')); return; }
      if (req.method === 'GET' && pathname === '/api/account/state') { json(res, 200, await accountActions.state(params.get('seriesId'), { fresh: params.get('refresh') === '1' })); return; }
      if (req.method === 'GET' && pathname === '/api/account/sync') { json(res, 200, await accountSync.pull(Object.fromEntries(params))); return; }
      if (req.method === 'GET' && pathname === '/api/account/resume') { json(res, 200, await accountSync.resume(params.get('seriesId'), params.get('accountEpoch'))); return; }
      if (req.method === 'POST' && pathname === '/api/account/action') { json(res, 200, await accountActions.set(await body(req))); return; }
      if (req.method === 'POST' && pathname === '/api/account/progress') { json(res, 200, await accountActions.progress(await body(req))); return; }
      if (req.method === 'POST' && pathname === '/api/account/login') { await body(req); json(res, 200, await account.start()); return; }
      if (req.method === 'POST' && pathname === '/api/account/poll') { const input = await body(req); json(res, 200, await account.poll(input.id)); return; }
      if (req.method === 'POST' && pathname === '/api/account/disconnect') { await body(req); json(res, 200, await account.disconnect()); return; }
      const detail = pathname.match(/^\/api\/series\/(\d{1,24})$/);
      if (req.method === 'GET' && detail) { json(res, 200, await catalog.detail(detail[1])); return; }
      if (req.method === 'POST' && pathname === '/api/play') {
        const input = await body(req); const entry = await playback.resolve(input.seriesId, input.number, { refresh: input.refresh === true });
        if (res.destroyed) { playback.mobile.cancelUnleased(entry.job); return; }
        playback.begin(entry, input.clientId); json(res, 200, playback.public(entry)); return;
      }
      if (req.method === 'POST' && pathname === '/api/seek') { json(res, 200, await playback.seek(await body(req))); return; }
      if (req.method === 'POST' && pathname === '/api/preload') { json(res, 200, await playback.preload(await body(req), () => res.destroyed)); return; }
      if (req.method === 'POST' && pathname === '/api/preload/adopt') { json(res, 200, playback.adopt(await body(req))); return; }
      if (req.method === 'POST' && pathname === '/api/preload/release') { const input = await body(req); if (playback.sessions.get(input.clientId)?.anchor === input.session) playback.releaseNext(input.clientId, input.nextClientId); json(res, 200, { released: true }); return; }
      if (req.method === 'POST' && pathname === '/api/release') { const input = await body(req); playback.release(input.token, input.clientId); json(res, 200, { released: true }); return; }
      const playbackStatus = pathname.match(/^\/api\/playback\/([a-f0-9]{48})$/);
      if (req.method === 'GET' && playbackStatus) {
        const entry = await playback.byToken(playbackStatus[1]); playback.claim(entry, params.get('client'), { renew: true });
        json(res, 200, playback.public(entry)); return;
      }
      const segment = pathname.match(/^\/hls\/([a-f0-9]{48})\/(index\.m3u8|init\.mp4|part-\d{5}\.m4s)$/);
      if (['GET', 'HEAD'].includes(req.method) && segment) {
        const entry = await playback.byToken(segment[1]);
        await serveHLS(req, res, playback, entry, segment[2]); return;
      }
      const media = pathname.match(/^\/media\/([a-f0-9]{48})$/);
      if (['GET', 'HEAD'].includes(req.method) && media) {
        const entry = await playback.byToken(media[1]);
        await serveMedia(req, res, entry, playback);
        return;
      }
      if (['GET', 'HEAD'].includes(req.method) && staticFiles.has(pathname)) {
        const [name, type] = staticFiles.get(pathname);
        let content = await readFile(new URL('../web/' + name, import.meta.url), 'utf8');
        if (pathname === '/') content = content.replace('{{ADMIN_PATH}}', encodeURIComponent(adminPath));
        res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      throw new AppError('NOT_FOUND', '页面不存在', 404);
    } catch (e) {
      if (!['SEEK_SUPERSEDED', 'PLAY_CANCELLED'].includes(e.code)) console.error(JSON.stringify({ event: 'request_failed', code: e.code || e.name, message: String(e.message).replace(/https?:\/\/\S+/g, '[upstream]').slice(0, 180) }));
      if (res.headersSent) { res.destroy(); return; }
      if (e.retryAfterSeconds) res.setHeader('retry-after', String(e.retryAfterSeconds));
      json(res, e.status || 503, { code: e.code || 'UNAVAILABLE', error: e instanceof AppError ? e.message : '请求暂未完成，请稍后重试', retryAfterSeconds: e.retryAfterSeconds });
    }
  }

  return {
    handle,
    async close() {
      await Promise.allSettled([browser.close(), playback.close()]);
    },
  };
}

async function serveHLS(req, res, playback, entry, name, token, playSessionId) {
  const asset = await playback.mobile.asset(entry.job, name);
  if (name !== 'index.m3u8') {
    await serveFile(req, res, asset);
    return;
  }
  let playlist = Buffer.from(await playback.mobile.playlist(entry.job));
  if (token) {
    // HLS players resolve segment URLs relative to the manifest, without its query.
    const authQuery = new URLSearchParams({ api_key: token });
    if (playSessionId) authQuery.set('PlaySessionId', playSessionId);
    playlist = Buffer.from(playlist.toString('utf8').replace(
      '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
    ).replace(
      /^part-\d{5}\.m4s(?=\r?$)|(?<=URI=")init\.mp4(?=")/gm,
      name => name + '?' + authQuery,
    ));
  }
  res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': playlist.length, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : playlist);
}

async function serveGrowingMP4(req, res, playback, entry, keepAlive) {
  // 不给长度、不声明 Range：客户端只能从头顺序读；转完以后再打开拿到的是能拖动的完整 MP4
  res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') { res.end(); return; }
  const controller = new AbortController(); res.once('close', () => controller.abort());
  // 推流期间一直占着这一集，别被其他播放请求当成没人看给取消或清掉
  keepAlive(); const renew = setInterval(keepAlive, 10_000);
  try {
    for await (const chunk of playback.mobile.progressive(entry.job, { signal: controller.signal })) {
      if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
    }
    res.end();
  } catch { res.destroy(); } finally { clearInterval(renew); }
}

async function serveMedia(req, res, entry, playback) {
  const range = req.headers.range;
  if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 70)) throw new AppError('BAD_RANGE', '不支持此范围请求', 416);
  if (entry.job) { const job = await entry.job.done; await serveFile(req, res, job); return; }
  if (entry.file) { await serveFile(req, res, entry); return; }
  const controller = new AbortController(); res.on('close', () => controller.abort());
  let upstream;
  try { upstream = await fetch(entry.url, { method: req.method, headers: { 'user-agent': USER_AGENT, referer: ORIGIN + '/', ...(range ? { range } : {}) }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]), redirect: 'error' }); }
  catch { throw new AppError('MEDIA_FETCH_FAILED', '官方媒体暂不可用，请重新选集'); }
  if (![200, 206, 416].includes(upstream.status)) { await upstream.body?.cancel(); playback.entries.delete(entry.key); throw new AppError('MEDIA_FETCH_FAILED', `官方媒体暂不可用（${upstream.status}），请重新选集`); }
  const headers = { 'cache-control': 'no-store', 'content-type': 'video/mp4' };
  for (const key of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers.has(key)) headers[key] = upstream.headers.get(key);
  res.writeHead(upstream.status, headers);
  if (req.method === 'HEAD' || !upstream.body) { await upstream.body?.cancel(); res.end(); }
  else { const stream = Readable.fromWeb(upstream.body); stream.on('error', () => res.destroy()); stream.pipe(res); }
}
