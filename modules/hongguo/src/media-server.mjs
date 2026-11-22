import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, imageURL } from './common.mjs';

const username = 'hongguo';
const serverName = 'IPTV 红果短剧';
const seasonNumber = 0xffffff;
const guid = /^[0-9a-f]{32}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const maxSessions = 128;
const maxUserItems = 1000;
const ticksPerSecond = 10_000_000;
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function playbackPassword(key) {
  // The original salt keeps existing Emby passwords valid.
  return createHmac('sha256', key).update('iptv-hongguo-jellyfin-password-v1').digest('base64url').slice(0, 24);
}

export function isEmbyPath(pathname) {
  // Mount the Emby namespaces directly under the module root, alongside the admin page and its APIs.
  return /^\/(?:system|users|sessions|views|userviews|library|items|useritems|shows|videos?|favoriteitems|playeditems)(?:\/|$)/i.test(pathname);
}

function matchesPassword(input, expected) {
  return typeof input === 'string' && input.length === expected.length
    && timingSafeEqual(Buffer.from(digest(input), 'hex'), Buffer.from(digest(expected), 'hex'));
}

function privateId(state, label) {
  return digest(state.serverId + ':' + label).slice(0, 32);
}

function mediaId(seriesId, number = 0) {
  // Preserve decimal upstream IDs above Number.MAX_SAFE_INTEGER. Mapping is
  // reversible without materializing an index of every episode in the library.
  return 'a1f710' + BigInt(seriesId).toString(16).padStart(20, '0') + number.toString(16).padStart(6, '0');
}

function normalizeId(value) {
  if (typeof value !== 'string') return '';
  const result = value.replaceAll('-', '').toLowerCase();
  return guid.test(result) ? result : '';
}

function mediaRef(state, value) {
  const id = normalizeId(value);
  if (id === privateId(state, 'library')) return { id, kind: 'CollectionFolder' };
  if (!id.startsWith('a1f710')) return null;
  const numeric = BigInt('0x' + id.slice(6, 26));
  const show = state.series.find(item => BigInt(item.id) === numeric);
  const number = Number.parseInt(id.slice(26), 16);
  if (!show || (number !== seasonNumber && number > show.total)) return null;
  return { id, kind: number === 0 ? 'Series' : number === seasonNumber ? 'Season' : 'Episode', show, number };
}

function itemRefs(state, parentId, includeTypes, recursive) {
  const parent = parentId ? mediaRef(state, parentId) : null;
  if (parentId && !parent) return [];
  const wants = kind => !includeTypes.size || includeTypes.has(kind.toLowerCase());
  if (parent?.kind === 'Episode') return [];
  if (parent?.show) {
    const show = parent.show;
    if (parent.kind === 'Series' && !recursive && !includeTypes.has('episode')) {
      return wants('Season') ? [mediaRef(state, mediaId(show.id, seasonNumber))] : [];
    }
    return wants('Episode') ? episodeRefs(show) : [];
  }
  if (!wants('Series')) return recursive && includeTypes.has('episode') ? state.series.flatMap(episodeRefs) : [];
  return state.series.map(show => ({ id: mediaId(show.id), kind: 'Series', show, number: 0 }));
}

function episodeRefs(show) {
  return Array.from({ length: show.total }, (_, i) => ({
    id: mediaId(show.id, i + 1), kind: 'Episode', show, number: i + 1,
  }));
}

function publicInfo(state) {
  return { Id: state.serverId, ServerName: serverName, Version: '4.9.0.0', ProductName: 'Emby Server', StartupWizardCompleted: true };
}

function user(state) {
  return {
    Id: privateId(state, 'user'), Name: username, ServerId: state.serverId,
    HasPassword: true, HasConfiguredPassword: true,
    Policy: {
      IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableAllFolders: true,
      EnableMediaPlayback: true, EnablePlaybackRemuxing: false, EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false, EnableContentDownloading: false,
      EnableRemoteAccess: true, EnableLiveTvAccess: false, EnableContentDeletion: false,
    },
  };
}

function readAuth(req, query) {
  const header = req.headers.authorization || req.headers['x-emby-authorization'] || '';
  return query.get('api_key') || req.headers['x-emby-token'] || req.headers['x-mediabrowser-token']
    || header.match(/(?:^|[ ,])Token="([a-f0-9]{64})"/i)?.[1] || header.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] || '';
}

function deviceKey(req) {
  const header = req.headers.authorization || req.headers['x-emby-authorization'] || '';
  const device = header.match(/(?:^|[ ,])DeviceId="([^"]{1,128})"/i)?.[1];
  return device ? digest('emby:' + device) : undefined;
}

function sessionDto(state, session) {
  return {
    Id: session.id, UserId: privateId(state, 'user'), UserName: username, ServerId: state.serverId,
    SupportsRemoteControl: false, SupportsMediaControl: false, PlayableMediaTypes: ['Video'],
  };
}

function authorization(state, keyHash) {
  const session = (state.jellyfinSessions || []).find(entry => entry.hash === keyHash);
  if (!session) throw new AppError('MEDIA_SERVER_UNAUTHORIZED', '请使用红果后台提供的播放账号', 401);
  return session;
}

function requestUser(state, requested) {
  if (requested && normalizeId(requested) !== privateId(state, 'user')) {
    throw new AppError('MEDIA_SERVER_NOT_FOUND', '用户不存在', 404);
  }
}

function userData(state, id) {
  const saved = state.jellyfinUserData?.[id] || {};
  const played = saved.played === true;
  return {
    Key: id, PlaybackPositionTicks: saved.position || 0, Played: played,
    PlayCount: played ? 1 : 0, IsFavorite: saved.favorite === true, LastPlayedDate: saved.at,
  };
}

function itemDto(state, ref) {
  const { id, kind, show, number } = ref;
  const base = { Id: id, ServerId: state.serverId, Type: kind, UserData: userData(state, id) };
  const libraryId = privateId(state, 'library');
  if (kind === 'CollectionFolder') {
    return { ...base, Name: '红果短剧', CollectionType: 'tvshows', IsFolder: true, ChildCount: state.series.length };
  }
  const seriesId = mediaId(show.id);
  const imageTags = show.cover ? { Primary: digest(show.cover).slice(0, 16) } : {};
  if (kind === 'Series') {
    return {
      ...base, Name: show.title, Overview: show.intro, Genres: show.tags, ParentId: libraryId,
      ImageTags: imageTags, PrimaryImageAspectRatio: 2 / 3, IsFolder: true,
      ChildCount: 1, RecursiveItemCount: show.total,
    };
  }
  if (kind === 'Season') {
    return {
      ...base, Name: '全集', IndexNumber: 1, SeriesId: seriesId, SeriesName: show.title,
      ParentId: seriesId, ImageTags: imageTags, IsFolder: true, ChildCount: show.total,
    };
  }
  return {
    ...base, Name: `第 ${number} 集`, IndexNumber: number, ParentIndexNumber: 1, SeasonName: '全集',
    SeriesId: seriesId, SeriesName: show.title, ParentId: mediaId(show.id, seasonNumber), SeasonId: mediaId(show.id, seasonNumber),
    Container: 'mp4', MediaType: 'Video', IsFolder: false, RunTimeTicks: state.jellyfinUserData?.[id]?.runtime,
    DanmakuUrl: `/Items/${id}/Danmaku`,
    ImageTags: imageTags, SeriesPrimaryImageTag: imageTags.Primary, PrimaryImageAspectRatio: 2 / 3,
  };
}

function sliceItems(items, query) {
  const boundedIndex = (key, fallback) => /^\d{1,8}$/.test(query.get(key) || '') ? Number(query.get(key)) : fallback;
  const start = boundedIndex('startindex', 0);
  const limit = Math.min(boundedIndex('limit', 200), 1000);
  return { Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start };
}

function filteredItems(state, refs, query) {
  const term = query.get('searchterm')?.trim().toLowerCase();
  const filters = (query.get('filters') || '').toLowerCase().split(',');
  const favorites = query.get('isfavorite') === 'true' || filters.includes('isfavorite');
  const played = query.get('isplayed') ?? (filters.includes('isplayed') ? 'true' : filters.includes('isunplayed') ? 'false' : null);
  const sort = query.get('sortby')?.toLowerCase();
  let items = refs.map(ref => itemDto(state, ref)).filter(item =>
    (!term || (item.Name + ' ' + (item.SeriesName || '')).toLowerCase().includes(term)) &&
    (!favorites || item.UserData.IsFavorite) && (played === null || item.UserData.Played === (played === 'true')));
  if (sort?.includes('random')) {
    // Only the head is used by clients asking for shuffle.
    if (items.length) return [items[Math.floor(Math.random() * items.length)]];
    return items;
  }
  if (sort?.includes('sortname') && !sort.startsWith('datecreated')) {
    items.sort((a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true }));
    if (query.get('sortorder')?.toLowerCase() === 'descending') items.reverse();
  }
  return items;
}

function historyItems(state, query, nextUp) {
  const seriesId = normalizeId(query.get('seriesid'));
  const parentId = normalizeId(query.get('parentid'));
  const seen = new Set();
  return Object.entries(state.jellyfinUserData || {})
    .filter(([, data]) => data.at)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .flatMap(([id, data]) => {
      const ref = mediaRef(state, id);
      if (ref?.kind !== 'Episode' || (seriesId && seriesId !== mediaId(ref.show.id))
        || (parentId && parentId !== privateId(state, 'library') && parentId !== mediaId(ref.show.id))) return [];
      if (!nextUp) return !data.played && data.position && !data.hiddenFromResume ? [itemDto(state, ref)] : [];
      if (seen.has(ref.show.id)) return [];
      seen.add(ref.show.id);
      if (data.played && ref.number >= ref.show.total) return [];
      const next = data.played ? mediaRef(state, mediaId(ref.show.id, ref.number + 1)) : ref;
      return [itemDto(state, next)];
    });
}

async function writeUserData(catalog, keyHash, requestedId, change) {
  let result;
  await catalog.update(state => {
    authorization(state, keyHash);
    const ref = mediaRef(state, requestedId);
    if (!ref || ref.kind === 'CollectionFolder') throw new AppError('MEDIA_SERVER_NOT_FOUND', '项目不存在', 404);
    const records = { ...state.jellyfinUserData };
    const previous = records[ref.id] || {};
    const updated = change(previous, ref);
    if (updated === previous) {
      result = userData(state, ref.id);
      return state;
    }
    delete records[ref.id];
    records[ref.id] = updated;
    while (Object.keys(records).length > maxUserItems) delete records[Object.keys(records)[0]];
    const next = { ...state, jellyfinUserData: records };
    result = userData(next, ref.id);
    return next;
  });
  return result;
}

async function artwork(req, res, ref, fetcher) {
  const cover = imageURL(ref?.show?.cover);
  if (!cover) throw new AppError('MEDIA_SERVER_NOT_FOUND', '暂无海报', 404);
  const upstream = await fetcher(cover, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  const type = upstream.headers.get('content-type');
  if (!upstream.ok || !/^image\/(jpeg|png|webp|avif|gif)(?:;|$)/i.test(type || '')) {
    await upstream.body?.cancel();
    throw new AppError('MEDIA_SERVER_NOT_FOUND', '海报暂不可用', 404);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > 3_000_000) throw new AppError('MEDIA_SERVER_NOT_FOUND', '海报暂不可用', 404);
    chunks.push(chunk);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'private, max-age=300' });
  res.end(req.method === 'HEAD' ? undefined : Buffer.concat(chunks));
}

export function createMediaServer({ catalog, playback, danmaku, serveMedia, serveGrowing, serveHLS, body, json, fetcher = fetch }) {
  const sessionID = value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/i.test(value) ? value : '';
  const mediaLease = (keyHash, playSessionId) => `media-server:${keyHash}:${playSessionId}`;
  // PlaybackInfo 带了开始位置的 MP4 播放会话（续播）：边转边推的流不能拖动，这类请求仍等完整 MP4
  const resumingSessions = new Map();
  const markResuming = playSessionId => {
    for (const [id, expires] of resumingSessions) if (expires <= Date.now()) resumingSessions.delete(id);
    resumingSessions.delete(playSessionId); resumingSessions.set(playSessionId, Date.now() + 30 * 60_000);
    while (resumingSessions.size > 200) resumingSessions.delete(resumingSessions.keys().next().value);
  };
  async function authenticate(req, res) {
    const input = await body(req);
    const token = randomBytes(32).toString('hex');
    const device = deviceKey(req);
    const session = { id: randomBytes(16).toString('hex'), hash: digest(token), device };
    const state = await catalog.update(previous => {
      const name = input.Username ?? input.username;
      if (!previous.key || typeof name !== 'string' || name.toLowerCase() !== username
        || !matchesPassword(input.Pw ?? input.pw, playbackPassword(previous.key))) {
        throw new AppError('MEDIA_SERVER_UNAUTHORIZED', '播放账号或密码有误', 401);
      }
      const sessions = (previous.jellyfinSessions || []).filter(item => !device || item.device !== device);
      return { ...previous, jellyfinSessions: [...sessions, session].slice(-maxSessions) };
    });
    json(res, 200, { User: user(state), AccessToken: token, ServerId: state.serverId, ServerName: serverName, SessionInfo: sessionDto(state, session) });
  }

  function holdMedia(entry, keyHash, playSessionId) {
    entry.job?.leases.set(mediaLease(keyHash, playSessionId), Date.now() + 45_000);
  }

  async function playerEntry(res, keyHash, ref, { completeFile = false, resumeOffset = 0, playSessionId = '' } = {}) {
    if (ref?.kind !== 'Episode') throw new AppError('MEDIA_SERVER_NOT_FOUND', '分集不存在', 404);
    if (res.destroyed) return null;
    const entry = resumeOffset > 0
      ? await playback.resolveResumeHLS(ref.show.id, ref.number, resumeOffset)
      : await playback.resolve(ref.show.id, ref.number);
    if (!entry || res.destroyed) return null;
    holdMedia(entry, keyHash, playSessionId);
    // A seekable MP4 needs all bytes. PlaybackInfo and sequential streams can respond at the first segment.
    const file = entry.job && (completeFile || entry.job.complete) ? await entry.job.done : entry;
    const current = await catalog.read();
    authorization(current, keyHash);
    if (!mediaRef(current, ref.id)) throw new AppError('MEDIA_SERVER_NOT_FOUND', '分集已移除', 404);
    return res.destroyed ? null : { ...entry, ...file, job: entry.job };
  }

  return async function handle(req, res, pathname, query) {
    const route = pathname.toLowerCase().replace(/\/$/, '');
    const params = new Map([...query].map(([key, value]) => [key.toLowerCase(), value]));
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'Accept-Ranges, Content-Range, Content-Length');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Content-Type, Range',
      }).end();
      return;
    }
    const state = await catalog.read();
    if (!state.serverId) throw new AppError('MEDIA_SERVER_NOT_FOUND', '请先在 IPTV 后台打开点播目录', 404);
    if (req.method === 'GET' && route === '/system/info/public') { json(res, 200, publicInfo(state)); return; }
    if (req.method === 'GET' && route === '/users/public') { json(res, 200, []); return; }
    if (route === '/system/ping' && ['GET', 'HEAD', 'POST'].includes(req.method)) {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Emby Server');
      return;
    }
    if (req.method === 'POST' && route === '/users/authenticatebyname') { await authenticate(req, res); return; }
    const token = readAuth(req, params);
    const keyHash = typeof token === 'string' && tokenPattern.test(token) ? digest(token) : '';
    const session = authorization(state, keyHash);
    const scoped = route.match(/^\/users\/([a-f0-9-]+)(\/.*)?$/);
    requestUser(state, scoped?.[1] || params.get('userid'));
    // Legacy clients use /Users/{userId}/Items and modern clients use /Items.
    const path = scoped ? scoped[2] || '/users/me' : route;

    if (req.method === 'GET' && path === '/system/info') { json(res, 200, publicInfo(state)); return; }
    if (req.method === 'GET' && path === '/users/me') { json(res, 200, user(state)); return; }
    if (req.method === 'GET' && path === '/sessions') { json(res, 200, [sessionDto(state, session)]); return; }
    if (req.method === 'POST' && path === '/sessions/logout') {
      await catalog.update(previous => ({
        ...previous, jellyfinSessions: (previous.jellyfinSessions || []).filter(entry => entry.hash !== keyHash),
      }));
      res.writeHead(204).end(); return;
    }
    if (req.method === 'POST' && ['/sessions/capabilities', '/sessions/capabilities/full'].includes(path)) {
      req.resume(); res.writeHead(204).end(); return;
    }
    if (req.method === 'GET' && ['/views', '/userviews', '/library/mediafolders'].includes(path)) {
      json(res, 200, sliceItems([itemDto(state, mediaRef(state, privateId(state, 'library')))], params)); return;
    }
    if (req.method === 'GET' && ['/items/resume', '/useritems/resume', '/shows/nextup'].includes(path)) {
      json(res, 200, sliceItems(historyItems(state, params, path === '/shows/nextup'), params)); return;
    }
    if (req.method === 'GET' && ['/items', '/items/latest'].includes(path)) {
      const types = new Set((params.get('includeitemtypes') || '').toLowerCase().split(',').filter(Boolean));
      const refs = itemRefs(state, params.get('parentid'), types, params.get('recursive') === 'true');
      const items = sliceItems(filteredItems(state, refs, params), params);
      json(res, 200, path === '/items/latest' ? items.Items : items); return;
    }
    const hierarchy = path.match(/^\/shows\/([a-f0-9-]+)\/(seasons|episodes)$/);
    if (req.method === 'GET' && hierarchy) {
      const ref = mediaRef(state, hierarchy[1]);
      if (ref?.kind !== 'Series') throw new AppError('MEDIA_SERVER_NOT_FOUND', '剧集已移除', 404);
      const [, , child] = hierarchy;
      let refs = child === 'seasons' ? [mediaRef(state, mediaId(ref.show.id, seasonNumber))] : episodeRefs(ref.show);
      const season = params.get('seasonid');
      if (child === 'episodes' && season && normalizeId(season) !== mediaId(ref.show.id, seasonNumber)) refs = [];
      const from = normalizeId(params.get('startitemid'));
      if (from) {
        const index = refs.findIndex(item => item.id === from);
        refs = index < 0 ? [] : refs.slice(index);
      }
      json(res, 200, sliceItems(refs.map(item => itemDto(state, item)), params)); return;
    }
    const item = path.match(/^\/items\/([a-f0-9-]+)(?:\/(playbackinfo|images\/(?:primary|thumb|backdrop)(?:\/0)?|similar|userdata|hidefromresume|danmaku(?:\/segments)?))?$/);
    if (item) {
      const ref = mediaRef(state, item[1]);
      if (!ref) throw new AppError('MEDIA_SERVER_NOT_FOUND', '项目不存在', 404);
      const action = item[2];
      if (req.method === 'GET' && !action) { json(res, 200, itemDto(state, ref)); return; }
      if (req.method === 'GET' && ref.kind === 'Episode' && danmaku) {
        if (action === 'danmaku') { json(res, 200, await danmaku.metadata(ref, token)); return; }
        if (action === 'danmaku/segments') { json(res, 200, await danmaku.segment(ref, params.get('part'))); return; }
      }
      if (req.method === 'GET' && action === 'userdata') { json(res, 200, userData(state, ref.id)); return; }
      if (req.method === 'GET' && action === 'similar') { json(res, 200, sliceItems([], params)); return; }
      if (req.method === 'POST' && action === 'hidefromresume') {
        req.resume();
        await writeUserData(catalog, keyHash, ref.id, previous => ({
          ...previous, hiddenFromResume: params.get('hide') !== 'false',
        }));
        res.writeHead(204).end(); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && action?.startsWith('images/')) { await artwork(req, res, ref, fetcher); return; }
      if (['GET', 'POST'].includes(req.method) && action === 'playbackinfo') {
        if (req.method === 'POST') req.resume();
        const requestedSession = sessionID(params.get('playsessionid'));
        const playSessionId = requestedSession || randomBytes(16).toString('hex');
        const preferHLS = params.get('iptvpreferhls') === 'true';
        const previousSession = sessionID(params.get('iptvpreviousplaysessionid'));
        if (preferHLS && ref.kind === 'Episode' && previousSession && previousSession !== playSessionId && !res.destroyed) {
          playback.replaceMediaLease(ref.show.id, ref.number, mediaLease(keyHash, previousSession));
        }
        const startTicks = Number(params.get('starttimeticks') || 0);
        const resumeOffset = preferHLS && Number.isSafeInteger(startTicks) && startTicks > 0
          ? Math.floor(startTicks / 10_000) / 1000 : 0;
        if (!preferHLS && startTicks > 0) markResuming(playSessionId);
        let entry;
        if (resumeOffset > 0) {
          try {
            entry = await playerEntry(res, keyHash, ref, { resumeOffset, playSessionId });
          } catch (error) {
            if (error.code === 'APP_BUSY' || error.code?.startsWith('MEDIA_SERVER_')) throw error;
          }
        }
        if (!entry && !res.destroyed) entry = await playerEntry(res, keyHash, ref, { playSessionId });
        if (!entry) return;
        const duration = Math.round((entry.expectedDuration || entry.duration) * ticksPerSecond);
        const source = {
          Id: ref.id, Name: '红果', Container: 'mp4', Protocol: 'File', Type: 'Default',
          SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false,
          RunTimeTicks: duration, Size: entry.size ?? (entry.job?.complete ? entry.job.size : undefined),
          IsRemote: false, IsInfiniteStream: false,
          RequiresOpening: false, RequiresClosing: false, DefaultAudioStreamIndex: 1,
          MediaStreams: [
            { Type: 'Video', Codec: entry.video, Index: 0, Width: entry.width, Height: entry.height, IsDefault: true },
            { Type: 'Audio', Codec: entry.audio, Index: 1, IsDefault: true },
          ],
        };
        const offsetMs = Math.round((entry.job?.offset || 0) * 1000);
        if (preferHLS && entry.job && (offsetMs > 0 || (startTicks === 0 && !entry.job.complete))) {
          const offsetPath = offsetMs > 0 ? `${offsetMs}/` : '';
          source.DirectStreamUrl = `/Videos/${ref.id}/hls/${entry.token}/${offsetPath}index.m3u8`;
        }
        json(res, 200, { MediaSources: [source], PlaySessionId: playSessionId }); return;
      }
    }
    const video = path.match(/^\/videos?\/([a-f0-9-]+)\/(?:stream(?:\.mp4)?|original(?:\.mp4)?)$/);
    if (['GET', 'HEAD'].includes(req.method) && video) {
      const playSessionId = sessionID(params.get('playsessionid'));
      // 还在转码时，从头顺序读的请求（不带 Range 或 bytes=0-）边转边推，不用等整集转完才回应；
      // 带其他 Range 的（拖动、探测长度）和续播的仍等完整 MP4，免得拖不动、或前后两份文件的字节位置对不上
      const startTicks = Number(params.get('starttimeticks') || 0);
      const resuming = startTicks > 0 || resumingSessions.get(playSessionId) > Date.now();
      const sequential = !resuming && /^(?:bytes=0-)?$/.test(req.headers.range || '');
      const entry = await playerEntry(res, keyHash, mediaRef(state, video[1]), { completeFile: !sequential, playSessionId });
      if (!entry) return;
      if (entry.job && !entry.job.complete) {
        await serveGrowing(req, res, entry, () => { holdMedia(entry, keyHash, playSessionId); playback.renewLocalMedia(entry); });
      } else await serveMedia(req, res, entry);
      return;
    }
    const segment = path.match(/^\/videos\/([a-f0-9]{32})\/hls\/([a-f0-9]{48})\/(?:(\d{1,10})\/)?(index\.m3u8|init\.mp4|part-\d{5}\.m4s)$/);
    if (['GET', 'HEAD'].includes(req.method) && segment) {
      const [, episode, mediaToken, offsetPath, asset] = segment;
      const offsetMs = Number(offsetPath || 0);
      const playSessionId = sessionID(params.get('playsessionid'));
      const ref = mediaRef(state, episode);
      if (ref?.kind !== 'Episode') throw new AppError('MEDIA_SERVER_NOT_FOUND', '分集不存在', 404);
      let entry;
      try {
        entry = await playback.byToken(mediaToken, { localMedia: true });
      } catch (error) {
        // A retry can reopen the playlist after the job was evicted. A
        // cached playlist's segments must keep referring to their original bytes.
        // An offset playlist must never redirect to the full episode: its
        // client clock is relative to the trimmed stream. Reopen via PlaybackInfo.
        if (error.code !== 'SESSION_EXPIRED' || asset !== 'index.m3u8' || offsetMs > 0) throw error;
        const fresh = await playerEntry(res, keyHash, ref, { playSessionId });
        if (!fresh) return;
        if (fresh.job && fresh.token === mediaToken) throw error;
        const target = fresh.job ? `../${fresh.token}/index.m3u8` : '../../stream.mp4';
        const authQuery = new URLSearchParams({ api_key: token });
        if (playSessionId) authQuery.set('PlaySessionId', playSessionId);
        res.writeHead(307, { Location: target + '?' + authQuery, 'Cache-Control': 'no-store' }).end();
        return;
      }
      if (!entry.job || entry.seriesId !== ref.show.id || entry.number !== ref.number
        || Math.round((entry.job.offset || 0) * 1000) !== offsetMs) {
        throw new AppError('MEDIA_SERVER_NOT_FOUND', '播放分段不存在', 404);
      }
      holdMedia(entry, keyHash, playSessionId);
      playback.renewLocalMedia(entry);
      await serveHLS(req, res, entry, asset, token, playSessionId);
      return;
    }
    if (req.method === 'POST' && ['/sessions/playing', '/sessions/playing/progress', '/sessions/playing/stopped'].includes(path)) {
      const input = await body(req, 32_768);
      const ref = mediaRef(state, input.ItemId ?? input.itemId);
      if (ref?.kind !== 'Episode') throw new AppError('MEDIA_SERVER_NOT_FOUND', '分集不存在', 404);
      const playSessionId = sessionID(input.PlaySessionId ?? input.playSessionId);
      const stopped = path.endsWith('/stopped');
      const position = input.PositionTicks ?? input.positionTicks;
      if (Number.isSafeInteger(position) && position >= 0) {
        const runtime = Math.round(playback.episodeDuration(ref.show.id, ref.number) * ticksPerSecond);
        await writeUserData(catalog, keyHash, ref.id, previous => {
          const length = runtime || previous.runtime;
          const played = previous.played || (stopped && length > 0 && position >= length * 0.9);
          return {
            ...previous, runtime: length, played, position: played ? 0 : length > 0 ? Math.min(position, length) : position,
            hiddenFromResume: path === '/sessions/playing' ? false : previous.hiddenFromResume,
            at: new Date().toISOString(),
          };
        });
      }
      if (stopped && playSessionId) {
        playback.releaseMediaLease(ref.show.id, ref.number, mediaLease(keyHash, playSessionId));
      }
      if (path.endsWith('/progress') && Number.isSafeInteger(position) && position > 0 && !(input.IsPaused ?? input.isPaused) && ref.number < ref.show.total) {
        playback.warmNext(ref.show.id, ref.number + 1);
      }
      res.writeHead(204).end(); return;
    }
    const toggle = path.match(/^\/(favoriteitems|playeditems)\/([a-f0-9-]+)$/);
    if (['POST', 'DELETE'].includes(req.method) && toggle) {
      const enabled = req.method === 'POST';
      const result = await writeUserData(catalog, keyHash, toggle[2], previous => toggle[1] === 'favoriteitems'
        ? { ...previous, favorite: enabled }
        : { ...previous, played: enabled, position: 0, at: enabled ? new Date().toISOString() : undefined });
      json(res, 200, result); return;
    }
    throw new AppError('MEDIA_SERVER_NOT_FOUND', '此点播接口未提供该功能', 404);
  };
}
