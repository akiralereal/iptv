import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppError } from '../src/common.mjs';
import { PlaybackCatalog } from '../src/playback-catalog.mjs';
import { HongguoDanmaku } from '../src/danmaku.mjs';
import { createMediaServer, playbackPassword } from '../src/media-server.mjs';
import { Playback } from '../src/playback.mjs';
import { serveFile } from '../src/ranges.mjs';

test('Emby clients can discover, sign in, browse a series, stream and continue in order', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hongguo-media-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seriesId = '7503745441910017049';
  const cover = 'https://p3-reading-sign.fqnovelpic.com/cover.jpg';
  const coverBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const film = { id: seriesId, title: '剧集测试', intro: '', cover, total: 3, tags: ['剧情'] };
  const catalog = new PlaybackCatalog(root, { detail: async () => film });
  await catalog.set(seriesId, true);
  const original = await catalog.ensure();
  const file = path.join(root, 'fixture.mp4');
  await writeFile(file, '0123456789');
  const token = 'ab'.repeat(24);
  const completion = Promise.withResolvers();
  const job = { leases: new Map(), complete: false, done: completion.promise };
  let growing = { token, seriesId, number: 1, duration: 12, job };
  const resumeToken = 'ef'.repeat(24);
  const resumed = { ...growing, token: resumeToken, expectedDuration: 12, job: { ...job, offset: 5.025, leases: new Map() } };
  let resumeExpired = false;
  let renewals = 0;
  const warmed = [];
  const switchCandidates = [];
  const tokens = () => new Map([[growing.token, growing], [resumed.token, resumed]]);
  const playback = {
    entries: new Map(),
    async byToken(value, { localMedia }) {
      assert.equal(localMedia, true);
      if (value === resumed.token && !resumeExpired) return resumed;
      if (value !== growing.token) throw new AppError('SESSION_EXPIRED', 'Expired', 410);
      return growing;
    },
    renewLocalMedia(entry) { assert.ok(entry.job === growing.job || entry.job === resumed.job); renewals++; },
    episodeDuration() { return 12; },
    warmNext(...target) { warmed.push(target); },
    releaseMediaLease(seriesId, number, lease, options) {
      Playback.prototype.releaseMediaLease.call({ tokens: tokens() }, seriesId, number, lease, options);
    },
    replaceMediaLease(seriesId, number, lease) {
      const mobile = { cancelUnleased: candidate => switchCandidates.push(candidate) };
      Playback.prototype.replaceMediaLease.call({ tokens: tokens(), mobile }, seriesId, number, lease);
    },
    dropMediaLeases(leases) {
      Playback.prototype.dropMediaLeases.call({ mobile: { jobs: new Set([job, resumed.job]) } }, leases);
    },
    async resolveResumeHLS(id, number, offset) {
      assert.equal(id, seriesId);
      assert.equal(number, 1);
      if (offset === 11) return null;
      if (offset === 10) throw new AppError('APP_BUSY', 'Busy', 429);
      assert.equal(offset, resumed.job.offset);
      return resumed;
    },
    async resolve(id, number) {
      assert.equal(id, seriesId);
      if (number === 1) return growing;
      const entry = { file, size: 10, duration: 12, video: 'h264', audio: 'aac', width: 1080, height: 1920 };
      this.entries.set(`${id}:${number}`, entry);
      return entry;
    },
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  };
  const body = async req => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const windows = [];
  const danmaku = new HongguoDanmaku({
    catalog: { detail: async () => ({ total: 3, episodes: [{ id: '100' }, { id: '200' }, { id: '300' }] }) },
    playback: { episodeDuration: () => 70 },
    session: {
      parameters: async () => ({}),
      async signedPost(endpoint, params, bytes) {
        const input = JSON.parse(bytes);
        const { start_offset_time: start, book_id } = input.business_param;
        assert.equal(book_id, seriesId);
        assert.ok(endpoint.endsWith(`/${input.group_id}/v1/`));
        windows.push([input.group_id, start, input.cursor]);
        return { code: 0, data: {
          common_list_info: { has_more: start < 60000, cursor: `window-${start}` },
          extra: { next_query_danmaku_list_time: start + 30000 },
          data_list: [{ comment: { comment_id: String(Number(input.group_id) + start),
            common: { content: { text: `第 ${input.group_id} 集的弹幕` } }, expand: { offset_time: start + 5000 } } }],
        } };
      },
    },
  });
  const sequentialReads = [];
  const handle = createMediaServer({
    catalog, playback, danmaku, serveMedia: serveFile, json, body,
    serveGrowing(req, res, entry, keepAlive) {
      assert.equal(entry.job, job);
      keepAlive(); sequentialReads.push(req.headers.range || '');
      res.end(req.method === 'HEAD' ? undefined : 'growing');
    },
    async fetcher(url) {
      assert.equal(url, cover);
      return new Response(coverBytes, { headers: { 'content-type': 'image/jpeg' } });
    },
    serveHLS(req, res, entry, name, clientToken) {
      assert.ok(entry === growing || entry === resumed);
      assert.match(clientToken, /^[a-f0-9]{64}$/);
      res.end(name);
    },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handle(req, res, url.pathname, url.searchParams).catch(error => {
      assert.ok(error instanceof AppError, error.stack);
      json(res, error.status, { code: error.code });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (route, init) => fetch(origin + route, init);
  const post = (route, value, headers = {}) => get(route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
  const assertStatus = async (response, status) => {
    assert.equal(response.status, status);
    await response.body?.cancel();
  };

  const publicInfo = await get('/System/Info/Public').then(r => r.json());
  assert.equal(publicInfo.Id, original.serverId);
  assert.equal(publicInfo.ProductName, 'Emby Server');
  assert.equal(await get('/System/Ping', { method: 'POST' }).then(r => r.text()), 'Emby Server');
  await assertStatus(await get('/Items'), 401);
  await assertStatus(await post('/Users/AuthenticateByName', { Username: 'hongguo', Pw: original.key }), 401);
  async function signIn(key, device) {
    const response = await post('/Users/AuthenticateByName', { Username: 'hongguo', Pw: playbackPassword(key) }, {
      'x-emby-authorization': `MediaBrowser Client="Test", DeviceId="${device}"`,
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const auth = await signIn(original.key, 'first');
  const other = await signIn(original.key, 'second');
  assert.notEqual(auth.AccessToken, other.AccessToken);
  assert.notEqual(auth.AccessToken, playbackPassword(original.key));
  const headers = { 'x-emby-token': auth.AccessToken };
  const api = route => get(route, { headers }).then(r => {
    assert.equal(r.status, 200);
    return r.json();
  });
  const user = auth.User.Id;
  const views = await api(`/Users/${user}/Views`);
  const library = views.Items[0];
  assert.equal(library.CollectionType, 'tvshows');
  const rootItems = await api(`/Users/${user}/Items?ExcludeItemTypes=Audio,Book,MusicVideo,MusicAlbum,Game`);
  assert.deepEqual(rootItems.Items, [library]);
  const browse = await api(`/Users/${user}/Items?ParentId=${library.Id}&IncludeItemTypes=Series&Limit=1`);
  const series = browse.Items[0];
  assert.equal(series.Name, '剧集测试');
  assert.equal(browse.TotalRecordCount, 1);
  assert.equal((await api('/Items/Latest?ParentId=' + library.Id))[0].Id, series.Id);
  const latest = await api(`/Users/${user}/Items/Latest?IncludeItemTypes=Movie,Series&ParentId=${library.Id}`);
  assert.deepEqual(latest, [series]);
  const { Items: [season] } = await api(`/Shows/${series.Id}/Seasons?UserId=${user}`);
  const query = `/Shows/${series.Id}/Episodes?SeasonId=${season.Id}`;
  const { Items } = await api(query);
  assert.deepEqual(Items.map(item => item.IndexNumber), [1, 2, 3]);
  assert.equal(Items[0].SeriesId, series.Id);
  assert.equal(Items[0].ParentId, season.Id);
  assert.equal(Items[0].VideoType, 'VideoFile');
  assert.equal(Items[0].MediaSources[0].Id, Items[0].Id);
  assert.equal(Items[0].MediaSources[0].Container, 'mp4');
  assert.equal(Items[0].MediaSources[0].SupportsDirectStream, true);
  for (const child of [season, Items[0]]) {
    assert.deepEqual((await api(`/Shows/${child.Id}/Seasons?UserId=${user}`)).Items, [season]);
  }
  const coverPath = `/Items/${series.Id}/Images/Primary`;
  await assertStatus(await get(coverPath), 401);
  await assertStatus(await get(coverPath + '?tag=wrong'), 401);
  const coverResponse = await get(coverPath + '?tag=' + series.ImageTags.Primary);
  assert.equal(coverResponse.status, 200);
  assert.deepEqual(Buffer.from(await coverResponse.arrayBuffer()), coverBytes);
  assert.equal(series.DanmakuUrl, undefined);
  await assertStatus(await get(Items[0].DanmakuUrl), 401);
  for (const [index, videoId] of [[0, '100'], [1, '200']]) {
    const endpoint = Items[index].DanmakuUrl;
    assert.equal(endpoint, `/Items/${Items[index].Id}/Danmaku`);
    const metadata = await api(endpoint);
    assert.equal(metadata.videoID, `hongguo:${videoId}`);
    const url = new URL(metadata.segmentsURL, origin + endpoint);
    url.searchParams.set('part', '1');
    const segment = await fetch(url);
    assert.equal(segment.status, 200);
    const packet = await segment.json();
    assert.equal(packet.videoID, metadata.videoID);
    assert.deepEqual(packet.items.map(item => [item.time, item.text]), [[5, `第 ${videoId} 集的弹幕`], [35, `第 ${videoId} 集的弹幕`]]);
    await (await fetch(url)).body.cancel();
  }
  assert.deepEqual(windows, [['100', 0, ''], ['100', 30000, 'window-0'], ['200', 0, ''], ['200', 30000, 'window-0']]);
  const backdrop = `/Items/${Items[0].SeriesId}/Images/Backdrop/0?maxWidth=1200`;
  const artwork = await get(backdrop, { headers });
  assert.equal(artwork.status, 200);
  assert.equal(artwork.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await artwork.arrayBuffer()), coverBytes);
  assert.deepEqual((await api(query + '&startItemId=' + Items[1].Id)).Items.map(item => item.IndexNumber), [2, 3]);
  const firstInfo = `/Items/${Items[0].Id}/PlaybackInfo`;
  const first = await get(firstInfo, { headers, signal: AbortSignal.timeout(2000) }).then(r => r.json());
  assert.equal(first.MediaSources[0].DirectStreamUrl, undefined);
  const requestedHLS = await api(firstInfo + '?IPTVPreferHLS=true');
  const hls = requestedHLS.MediaSources[0].DirectStreamUrl;
  assert.equal(hls, `/Videos/${Items[0].Id}/hls/${token}/index.m3u8`);
  await assertStatus(await get(hls), 401);
  assert.equal(await get(hls, { headers }).then(r => r.text()), 'index.m3u8');
  assert.equal(renewals, 1);
  await assertStatus(await get(hls.replace(Items[0].Id, Items[1].Id), { headers }), 404);
  growing = { ...growing, token: 'cd'.repeat(24) };
  await assertStatus(await get(hls.replace('index.m3u8', 'part-00000.m4s'), { headers }), 410);
  const redirect = await get(hls, { headers, redirect: 'manual' });
  assert.equal(redirect.status, 307);
  const fresh = new URL(redirect.headers.get('location'), origin + hls);
  assert.equal(fresh.pathname, hls.replace(token, growing.token));
  assert.equal(fresh.searchParams.get('api_key'), auth.AccessToken);
  assert.equal(await fetch(fresh).then(r => r.text()), 'index.m3u8');
  assert.equal(renewals, 2);
  // 同一台设备开始续播：它之前的播放会话不再占着唯一的转码，晚到的请求也续不上租约；别的设备、同一账号的另一台设备不受影响
  const leaseKeys = () => [...job.leases.keys()];
  const earlier = requestedHLS.PlaySessionId;
  assert.ok(leaseKeys().some(lease => lease.endsWith(':' + earlier)));
  await assertStatus(await get(firstInfo + '?IPTVPreferHLS=true&PlaySessionId=elsewhere', { headers: { 'x-emby-token': other.AccessToken } }), 200);
  await assertStatus(await get(firstInfo + '?IPTVPreferHLS=true&PlaySessionId=tablet', { headers: {
    ...headers, 'x-emby-authorization': 'MediaBrowser Client="Test", DeviceId="tablet"' } }), 200);
  const resumeInfo = await api(firstInfo + '?IPTVPreferHLS=true&StartTimeTicks=50259999');
  assert.equal(leaseKeys().some(lease => lease.endsWith(':' + earlier)), false);
  assert.ok([...resumed.job.leases.keys()].some(lease => lease.endsWith(':' + resumeInfo.PlaySessionId)));
  assert.ok(leaseKeys().some(lease => lease.endsWith(':elsewhere')));
  assert.ok(leaseKeys().some(lease => lease.endsWith(':tablet')));
  assert.equal(await get(fresh.pathname + '?PlaySessionId=' + earlier, { headers }).then(r => r.text()), 'index.m3u8');
  assert.equal(leaseKeys().some(lease => lease.endsWith(':' + earlier)), false, 'a retired session cannot lease the job again');
  const resumeHls = resumeInfo.MediaSources[0].DirectStreamUrl;
  assert.equal(resumeHls, `/Videos/${Items[0].Id}/hls/${resumeToken}/5025/index.m3u8`);
  assert.equal(resumeInfo.MediaSources[0].RunTimeTicks, 120_000_000);
  assert.equal(await get(resumeHls, { headers }).then(r => r.text()), 'index.m3u8');
  assert.equal(await get(resumeHls.replace('index.m3u8', 'part-00000.m4s'), { headers }).then(r => r.text()), 'part-00000.m4s');
  await assertStatus(await get(resumeHls.replace('/5025/', '/5000/'), { headers }), 404);
  resumeExpired = true;
  await assertStatus(await get(resumeHls, { headers, redirect: 'manual' }), 410);
  const fallback = await api(firstInfo + '?IPTVPreferHLS=true&StartTimeTicks=110000000');
  assert.equal(fallback.MediaSources[0].DirectStreamUrl, undefined);
  await assertStatus(await get(firstInfo + '?IPTVPreferHLS=true&StartTimeTicks=100000000', { headers }), 429);

  const leaseCount = job.leases.size;
  const firstSession = await api(firstInfo + '?IPTVPreferHLS=true&PlaySessionId=first-session');
  assert.equal(firstSession.PlaySessionId, 'first-session');
  const secondSession = await api(firstInfo + '?IPTVPreferHLS=true&PlaySessionId=second-session');
  assert.equal(secondSession.PlaySessionId, 'second-session');
  await assertStatus(await get(firstSession.MediaSources[0].DirectStreamUrl + '?PlaySessionId=first-session', { headers }), 200);
  assert.equal(job.leases.size, leaseCount + 2);
  await assertStatus(await post('/Sessions/Playing/Stopped', {
    ItemId: Items[0].Id, PlaySessionId: 'first-session',
  }, headers), 204);
  assert.equal(job.leases.size, leaseCount + 1);
  assert.ok([...job.leases.keys()].some(lease => lease.endsWith(':second-session')));
  assert.equal([...job.leases.keys()].some(lease => lease.endsWith(':first-session')), false);
  const switchInfo = `/Items/${Items[1].Id}/PlaybackInfo?IPTVPreferHLS=true&PlaySessionId=third-session&IPTVPreviousPlaySessionId=second-session`;
  await assertStatus(await get(switchInfo, { headers: { 'x-emby-token': other.AccessToken } }), 200);
  assert.deepEqual(switchCandidates, []);
  assert.equal(job.leases.size, leaseCount + 1);
  assert.equal((await api(switchInfo)).PlaySessionId, 'third-session');
  assert.deepEqual(switchCandidates, [job]);
  assert.equal(job.leases.size, leaseCount);

  const seekingSession = 'hls-seek';
  const seekInfo = `${firstInfo}?IPTVPreferHLS=true&PlaySessionId=${seekingSession}`;
  const seekLease = key => key.endsWith(`:${seekingSession}`);
  const originalHLS = (await api(seekInfo)).MediaSources[0].DirectStreamUrl;
  assert.ok(leaseKeys().some(seekLease));
  const replacement = await api(seekInfo + '&IPTVSeekHLS=true&StartTimeTicks=50250000');
  assert.equal(replacement.PlaySessionId, seekingSession);
  assert.equal(replacement.MediaSources[0].DirectStreamUrl, resumeHls);
  assert.equal(leaseKeys().some(seekLease), false);
  assert.ok([...resumed.job.leases.keys()].some(seekLease));
  await assertStatus(await get(originalHLS + '?PlaySessionId=' + seekingSession, { headers }), 409);
  assert.equal(leaseKeys().some(seekLease), false, 'old HLS requests cannot keep their worker after seeking');
  // 还在转码：从头顺序读的 MP4 请求立刻开始推流，不等整集转完
  const growingMp4 = `/Videos/${Items[0].Id}/stream.mp4?PlaySessionId=direct-session`;
  const renewalsBefore = renewals;
  assert.equal(await get(growingMp4, { headers, signal: AbortSignal.timeout(2000) }).then(r => r.text()), 'growing');
  assert.equal(await get(growingMp4, { headers: { ...headers, range: 'bytes=0-' }, signal: AbortSignal.timeout(2000) }).then(r => r.text()), 'growing');
  assert.deepEqual(sequentialReads, ['', 'bytes=0-']);
  assert.ok(renewals > renewalsBefore); assert.ok([...job.leases.keys()].some(lease => lease.endsWith(':direct-session')));
  // 要拖动的 Range 请求、续播（PlaybackInfo 或地址里带开始位置）仍等完整 MP4：边转边推的流拖不动
  const seeking = get(growingMp4, { headers: { ...headers, range: 'bytes=2-4' } });
  assert.equal((await api(firstInfo + '?StartTimeTicks=50000000&PlaySessionId=resume-mp4')).PlaySessionId, 'resume-mp4');
  const resumedRead = get(`/Videos/${Items[0].Id}/stream.mp4?PlaySessionId=resume-mp4`, { headers });
  const resumedByUrl = get(growingMp4 + '&StartTimeTicks=50000000', { headers });
  await api(firstInfo + '?IPTVPreferHLS=true&StartTimeTicks=50250000&PlaySessionId=seekable-fallback');
  const hasResumeLease = () => [...resumed.job.leases.keys()].some(key => key.endsWith(':seekable-fallback'));
  assert.ok(hasResumeLease());
  const seekableFallback = get(`/Videos/${Items[0].Id}/stream.mp4?PlaySessionId=seekable-fallback&IPTVRequireSeekable=true`, {
    headers: { ...headers, range: 'bytes=0-' },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sequentialReads.length, 2);
  assert.equal(hasResumeLease(), false);
  resumeExpired = false;
  await assertStatus(await get(resumeHls + '?PlaySessionId=seekable-fallback', { headers }), 409);
  assert.equal(hasResumeLease(), false, 'a late HLS segment cannot reclaim the fallback session');
  job.complete = true;
  completion.resolve({ file, size: 10 });
  const seeked = await seeking;
  assert.equal(seeked.status, 206); assert.equal(await seeked.text(), '234');
  for (const response of [await resumedRead, await resumedByUrl]) {
    assert.equal(response.status, 200); assert.equal(response.headers.get('accept-ranges'), 'bytes'); assert.equal(await response.text(), '0123456789');
  }
  const seekable = await seekableFallback;
  assert.equal(seekable.status, 206);
  assert.equal(seekable.headers.get('content-range'), 'bytes 0-9/10');
  assert.equal(await seekable.text(), '0123456789');
  await assertStatus(await get(`/Videos/${Items[0].Id}/stream.mp4`, { headers, method: 'HEAD' }), 200);
  assert.equal(sequentialReads.length, 2, 'a finished episode is served as the seekable MP4');
  assert.equal((await api(firstInfo + '?IPTVPreferHLS=true')).MediaSources[0].DirectStreamUrl, undefined);
  const play = await post('/Items/' + Items[1].Id + '/PlaybackInfo', { DeviceProfile: {} }, headers);
  assert.equal(play.status, 200);
  const metadata = await play.json();
  assert.equal(metadata.MediaSources[0].Container, 'mp4');
  assert.equal(metadata.MediaSources[0].RunTimeTicks, 120_000_000);
  const directInfo = await post(`/Users/${user}/Items/${Items[1].Id}/PlaybackInfo?IsPlayback=true`, { DeviceProfile: {} }, headers);
  assert.equal(directInfo.status, 200);
  const { MediaSources: [direct], PlaySessionId } = await directInfo.json();
  assert.equal(direct.Protocol, 'Http');
  assert.equal(direct.SupportsDirectPlay, false);
  const directURL = new URL(direct.DirectStreamUrl, origin);
  assert.equal(directURL.pathname, `/Videos/${Items[1].Id}/stream.mp4`);
  assert.equal(directURL.searchParams.get('PlaySessionId'), PlaySessionId);
  const directRange = await fetch(directURL, { headers: { range: 'bytes=0-2' } });
  assert.equal(directRange.status, 206);
  assert.equal(await directRange.text(), '012');
  const mp4 = `/Videos/${Items[1].Id}/stream.mp4?Static=true&api_key=${auth.AccessToken}`;
  const range = await get(mp4, { headers: { range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await range.text(), '234');
  await assertStatus(await get(mp4, { method: 'HEAD' }), 200);

  const itemId = Items[1].Id;
  await assertStatus(await post('/Sessions/Playing/Progress', { ItemId: itemId, PositionTicks: 50_000_000 }, headers), 204);
  await assertStatus(await post('/Sessions/Playing/Progress', { ItemId: itemId, PositionTicks: 50_000_000, IsPaused: true }, headers), 204);
  assert.deepEqual(warmed, [[seriesId, 3]]);
  assert.equal((await api('/UserItems/Resume')).Items[0].Id, itemId);
  const hide = `/Users/${user}/Items/${itemId}/HideFromResume`;
  await assertStatus(await post(hide + '?Hide=true', {}, headers), 204);
  assert.deepEqual((await api('/UserItems/Resume')).Items, []);
  assert.equal((await api(`/Users/${user}/Items/${itemId}`)).UserData.PlaybackPositionTicks, 50_000_000);
  await assertStatus(await post(hide + '?Hide=false', {}, headers), 204);
  assert.equal((await api('/UserItems/Resume')).Items[0].Id, itemId);
  await assertStatus(await post('/Sessions/Playing/Stopped', { ItemId: itemId, PositionTicks: 120_000_000 }, headers), 204);
  assert.equal((await api('/Shows/NextUp')).Items[0].Id, Items[2].Id);
  await assertStatus(await post('/Sessions/Playing/Progress', { ItemId: Items[2].Id, PositionTicks: 100_000_000 }, headers), 204);
  assert.deepEqual(warmed, [[seriesId, 3]]);
  await assertStatus(await post('/Users/' + user + '/PlayedItems/' + Items[2].Id, {}, headers), 200);
  assert.deepEqual((await api('/Shows/NextUp')).Items, []);

  await catalog.set(seriesId, false);
  await assertStatus(await get(mp4), 404);
  await assertStatus(await post('/Sessions/Logout', {}, headers), 204);
  await assertStatus(await get('/Items', { headers }), 401);
  await assertStatus(await get('/Items', { headers: { 'x-emby-token': other.AccessToken } }), 200);
  const rotated = await catalog.rotate();
  assert.equal(rotated.serverId, original.serverId);
  await assertStatus(await get('/Items', { headers: { 'x-emby-token': other.AccessToken } }), 401);
  await assertStatus(await post('/Users/AuthenticateByName', { Username: 'hongguo', Pw: playbackPassword(original.key) }), 401);
});
