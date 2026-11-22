import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MobilePlayback, parsePlaylist } from '../src/mobile/playback.mjs';
import { SourceBridge, MAX_SOURCE } from '../src/mobile/source-bridge.mjs';
import { byteRange } from '../src/ranges.mjs';
import { decodeMedia } from '../src/media.mjs';
import { Playback } from '../src/playback.mjs';
import { seekPosition } from '../src/seek.mjs';
const run = promisify(execFile);
const key = Buffer.alloc(16, 17), kid = Buffer.alloc(16, 34);
const sourceURL = 'https://fixture.qznovelvod.com/test.mp4';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture({ colors = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-stream-test-'));
  const file = path.join(root, 'input.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    ...(colors ? ['-vf', "drawbox=x=0:y=0:w=64:h=64:color=red:t=fill:enable='lt(t,4)',drawbox=x=0:y=0:w=64:h=64:color=blue:t=fill:enable='gte(t,4)*lt(t,8)',drawbox=x=0:y=0:w=64:h=64:color=green:t=fill:enable='gte(t,8)'"] : []),
    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-g', '60', '-c:a', 'aac', '-movflags', '+faststart',
    '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key.toString('hex'), '-encryption_kid', kid.toString('hex'), file]);
  return { root, data: await readFile(file) };
}
function mediaFetcher(data, { failAfter = Infinity, failOnce = false, wait = 5, chunkBytes = 16384, requests = [] } = {}) {
  let served = 0, failed = false;
  return async (url, options) => {
    assert.equal(url, sourceURL); assert.equal(options.redirect, 'error');
    const range = byteRange(options.headers.range, data.length);
    if (!range) return new Response(null, { status: 416 });
    requests.push(range.start);
    let offset = range.start;
    const body = new ReadableStream({ async pull(controller) {
      await sleep(wait);
      if (options.signal.aborted) { controller.error(new Error('Aborted')); return; }
      if (served >= failAfter && !(failOnce && failed)) { failed = true; controller.error(new Error('Synthetic network interruption')); return; }
      if (offset > range.end) { controller.close(); return; }
      const chunk = data.subarray(offset, Math.min(offset + chunkBytes, range.end + 1)); offset += chunk.length; served += chunk.length; controller.enqueue(chunk);
    } });
    return new Response(body, { status: range.status, headers: { 'content-length': String(range.end - range.start + 1), 'accept-ranges': 'bytes', ...(range.status === 206 ? { 'content-range': `bytes ${range.start}-${range.end}/${data.length}` } : {}) } });
  };
}
function models() { return { resolve: async videoId => ({ url: sourceURL, contentKey: Buffer.from(key), expectedDuration: 12, videoId, identityVerified: true, codec: 'h264', provider: 'fixture' }) }; }

test('encrypted input plays before download completes; final output still decodes completely', { timeout: 30_000 }, async () => {
  const { root, data } = await fixture();
  const playback = new MobilePlayback(root, { models: models(), bridge: new SourceBridge(mediaFetcher(data)) });
  try {
    const [job, duplicate] = await Promise.all([playback.prepare('1'), playback.prepare('1')]);
    assert.strictEqual(duplicate, job); assert.equal(playback.jobs.size, 1);
    assert.equal(job.complete, false); assert.equal(job.video, 'h264');
    assert.ok(job.timing.inputBytesAtFirstSegment < data.length, 'must not wait for the whole encrypted input');
    const early = parsePlaylist(await readFile((await playback.asset(job, 'index.m3u8')).file, 'utf8'));
    assert.ok(early.segments.length > 0); assert.equal(early.ended, false);
    await assert.rejects(playback.asset(job, '../input.mp4'), { code: 'NOT_FOUND' });
    await assert.rejects(playback.asset(job, 'part-00000.m4s.tmp'), { code: 'NOT_FOUND' });
    // MP4 直放客户端边转边收到的顺序流：转完后拼起来就是完整可解码的一集，且不带只覆盖单段的 sidx
    const chunks = []; for await (const chunk of playback.progressive(job)) chunks.push(chunk);
    await job.done;
    const growing = Buffer.concat(chunks), types = new Set();
    for (let offset = 0; offset < growing.length; offset += growing.readUInt32BE(offset)) types.add(growing.toString('latin1', offset + 4, offset + 8));
    assert.deepEqual([...types].sort(), ['ftyp', 'mdat', 'moof', 'moov']);
    await writeFile(path.join(root, 'growing.mp4'), growing);
    const frames = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path.join(root, 'growing.mp4')]);
    assert.equal(Number(frames.stdout.trim()), 360);
    assert.equal(parsePlaylist(await readFile(job.playlist, 'utf8')).ended, true);
    const decoded = await decodeMedia(job.file, job, job.expectedDuration, { local: true });
    assert.equal(decoded.classification, 'complete'); assert.ok(job.timing.completeMs > job.timing.firstSegmentMs);
    job.expiresAt = Date.now() + 1000;
    assert.ok(playback.renew(job) - Date.now() > 60_000);
    job.expiresAt = Date.now() - 1; await playback.prune(); assert.equal(playback.available(job), false); await assert.rejects(access(job.directory));
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('a dropped source connection resumes where it stopped instead of failing the episode', { timeout: 30_000 }, async () => {
  const { root, data } = await fixture(); const requests = [];
  const playback = new MobilePlayback(root, { models: models(), bridge: new SourceBridge(mediaFetcher(data, { failAfter: Math.floor(data.length / 2), failOnce: true, requests })) });
  try {
    const job = await playback.prepare('2b');
    await job.done; assert.equal(job.complete, true);
    assert.ok(requests.some(start => start > data.length / 4), 'FFmpeg must reconnect with a Range from the break, not restart');
    assert.equal((await decodeMedia(job.file, job, job.expectedDuration, { local: true })).classification, 'complete');
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('an interrupted encrypted stream is never advertised as complete but keeps converted segments for viewers', { timeout: 60_000 }, async () => {
  const { root, data } = await fixture();
  const playback = new MobilePlayback(root, { models: models(), bridge: new SourceBridge(mediaFetcher(data, { failAfter: Math.floor(data.length / 2) })) });
  try {
    const job = await playback.prepare('2');
    await assert.rejects(job.done); await playback.worker?.done.catch(() => {});
    assert.equal(job.complete, false); assert.equal(playback.available(job), false);
    assert.equal(job.partial, true); assert.equal(playback.readable(job), true); assert.notEqual(job.hlsEnded, true);
    // 原始文件里 FFmpeg 出错退出时也写了 ENDLIST；对外的播放列表不能带，否则播放器会把断点当片尾
    const playlist = parsePlaylist(await playback.playlist(job));
    assert.ok(playlist.segments.length > 0); assert.equal(playlist.ended, false);
    assert.ok(Math.abs(job.availableDuration - playlist.duration) < 0.01);
    await playback.asset(job, playlist.segments.at(-1).name);
    assert.equal(new Playback({}, {}, root).public({ job, token: 't', duration: 12, expectedDuration: 12, expiresAt: Date.now() }).interrupted, true);
    // 有人在看就留着，没人看了就清掉（available 为 false，新请求不会复用它）
    job.leases.set('viewer', Date.now() + 45_000); await playback.prune(); assert.ok(playback.jobs.has(job));
    job.leases.clear(); await playback.prune(); assert.equal(playback.readable(job), false); await assert.rejects(access(job.directory));
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling before readiness stops work and shutdown removes runtime files', { timeout: 30_000 }, async () => {
  const { root, data } = await fixture();
  const playback = new MobilePlayback(root, { models: models(), bridge: new SourceBridge(mediaFetcher(data, { wait: 20 })) });
  const controller = new AbortController();
  try {
    const work = playback.prepare('3', { signal: controller.signal }); controller.abort();
    await assert.rejects(work, { code: 'PLAY_CANCELLED' });
    await playback.close(); await assert.rejects(access(playback.directory));
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('source bridge rejects oversized responses and never forwards an Origin request', async () => {
  let calls = 0;
  const bridge = new SourceBridge(async () => { calls++; return new Response('x', { headers: { 'content-length': String(MAX_SOURCE + 1) } }); });
  try {
    const input = await bridge.register({ url: sourceURL });
    const blocked = await fetch(input.url, { headers: { origin: 'https://example.test' } }); assert.equal(blocked.status, 404); assert.equal(calls, 0);
    assert.equal((await fetch(input.url)).status, 502); assert.equal(calls, 1);
    input.release(); assert.equal((await fetch(input.url)).status, 404);
  } finally { await bridge.close(); }
});

test('ByteVC2 normalization preserves encrypted bytes and offsets across split HTTP ranges', async () => {
  function box(type, ...parts) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + parts.reduce((size, part) => size + part.length, 0));
    header.write(type, 4);
    return Buffer.concat([header, ...parts]);
  }
  const privateConfig = box('bv2C', Buffer.alloc(38, 17));
  const protection = box('sinf', box('frma', Buffer.from('bvc2')), box('schi', box('tenc', Buffer.alloc(23, 21))));
  const sample = box('encv', Buffer.alloc(78), privateConfig, protection);
  const description = Buffer.alloc(8);
  description.writeUInt32BE(1, 4);
  const stsd = box('stsd', description, sample);
  const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))));
  const media = box('mdat', Buffer.from('untouched bv2C and bvc2 payload'));
  const data = Buffer.concat([box('ftyp', Buffer.from('isom')), moov, media]);
  const bridge = new SourceBridge(mediaFetcher(data, { chunkBytes: 7, wait: 0 }));
  try {
    const input = await bridge.register({ url: sourceURL, codec: 'bytevc2' });
    const whole = await fetch(input.url);
    assert.equal(whole.status, 200);
    const patched = Buffer.from(await whole.arrayBuffer());
    assert.equal(patched.length, data.length);
    assert.deepEqual(patched.subarray(-media.length), media);
    const configOffset = data.indexOf('bv2C') - 4;
    assert.equal(patched.readUInt32BE(configOffset), 14);
    assert.equal(patched.toString('ascii', configOffset + 4, configOffset + 8), 'vvcC');
    assert.equal(patched[configOffset + 12], 0xfe);
    assert.equal(patched.readUInt32BE(configOffset + 14), privateConfig.length - 14);
    const originalOffset = data.indexOf('frmabvc2') + 4;
    assert.equal(patched.toString('ascii', originalOffset, originalOffset + 4), 'vvi1');
    assert.deepEqual(patched.subarray(originalOffset + 4), data.subarray(originalOffset + 4));
    for (const start of [configOffset + 3, originalOffset + 2]) {
      const response = await fetch(input.url, { headers: { range: `bytes=${start}-${start + 17}` } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${start + 17}/${data.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), patched.subarray(start, start + 18));
    }
    input.release();
  } finally { await bridge.close(); }
});

test('cache pressure preserves playing episodes and expired leases become evictable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-lease-test-'));
  const playback = new MobilePlayback(root);
  try {
    const pinned = { videoId: '1', directory: path.join(root, 'one'), complete: true, diskBytes: 300_000_000, expiresAt: Date.now() + 10_000, leases: new Map([['viewer', Date.now() + 45_000]]) };
    const idle = { videoId: '2', directory: path.join(root, 'two'), complete: true, diskBytes: 300_000_000, expiresAt: Date.now() + 10_000, leases: new Map() };
    playback.jobs.add(pinned); playback.jobs.add(idle); await playback.prune();
    assert.ok(playback.jobs.has(pinned)); assert.equal(playback.jobs.has(idle), false);
    pinned.leases.set('viewer', Date.now() - 1); pinned.expiresAt = Date.now() - 1; await playback.prune(); assert.equal(playback.jobs.size, 0);
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('a full cache makes room for the next episode while preserving the current lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-next-cache-test-')); const playback = new MobilePlayback(root);
  try {
    const jobs = Array.from({ length: 12 }, (_, i) => ({ cacheKey: String(i), directory: path.join(root, String(i)), complete: true, diskBytes: 1000, expiresAt: Date.now() + 60000, leases: new Map(i === 0 ? [['watching', Date.now() + 45000]] : []) }));
    for (const job of jobs) playback.jobs.add(job);
    await playback.prune({ reserve: true });
    assert.equal(playback.jobs.size, 11); assert.ok(playback.jobs.has(jobs[0])); assert.equal(playback.jobs.has(jobs[1]), false);
    const active = { complete: false, cancel() {}, leases: new Map() }; playback.jobs.add(active);
    await playback.prune({ reserve: true });
    assert.equal(playback.jobs.size, 11); assert.ok(playback.jobs.has(active)); assert.ok(playback.jobs.has(jobs[0]));
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('the sole worker preserves active playback and yields a stopped episode to foreground selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-worker-switch-'));
  const playback = new MobilePlayback(root);
  playback.create = async (videoId, _, cacheKey) => {
    const completion = Promise.withResolvers();
    const job = { videoId, cacheKey, directory: path.join(root, videoId), expiresAt: Date.now() + 120_000,
      leases: new Map(), waiters: 0, diskBytes: 0, done: completion.promise };
    job.ready = Promise.resolve(job);
    job.cancel = () => {
      job.error ||= new Error('Cancelled background work');
      completion.reject(job.error);
    };
    playback.jobs.add(job);
    playback.entries.set(cacheKey, job);
    return job;
  };
  try {
    const previous = await playback.prepare('79', { priority: true });
    previous.leases.set('previous-session', Date.now() + 60_000);
    await assert.rejects(playback.prepare('80'), { code: 'APP_BUSY' });
    const queued = playback.prepare('81', { priority: true });
    await sleep(60);
    assert.equal(previous.error, undefined);
    assert.equal(playback.worker.job, previous);
    previous.leases.delete('previous-session');
    const next = await queued;
    assert.equal(next.videoId, '81');
    assert.ok(previous.error);
    assert.equal(playback.worker.job, next);
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('foreground work preempts standby conversion only after it exits, and reuses the chosen standby', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-worker-preempt-'));
  const playback = new MobilePlayback(root);
  let active = 0;
  playback.create = async (videoId, _, cacheKey) => {
    assert.equal(++active, 1, 'the previous worker must finish cleanup before spawning the next');
    const completion = Promise.withResolvers();
    const job = { videoId, cacheKey, directory: path.join(root, videoId), expiresAt: Date.now() + 120_000,
      leases: new Map(), waiters: 0, diskBytes: 0, done: completion.promise.finally(() => active--) };
    job.ready = Promise.resolve(job);
    job.cancel = reason => {
      if (job.error) return;
      job.error = reason ?? new Error('Cancelled');
      setTimeout(() => completion.reject(job.error), 40);
    };
    playback.jobs.add(job);
    playback.entries.set(cacheKey, job);
    return job;
  };
  try {
    const standby = await playback.prepare('2');
    standby.leases.set('standby-buffer', Date.now() + 60_000);
    const foreground = playback.prepare('5', { priority: true });
    await assert.rejects(standby.done, { code: 'PLAY_CANCELLED' });
    const chosen = await foreground;
    assert.equal(chosen.videoId, '5');
    assert.equal(active, 1);
    chosen.cancel();
    await playback.worker.done.catch(() => {});
    const next = await playback.prepare('6');
    assert.equal(await playback.prepare('6', { priority: true }), next);
    assert.equal(playback.worker.priority, true);
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('resuming a fully converted episode answers with the whole file instead of converting again', async () => {
  const playback = new Playback({ detail: async () => ({ title: 'fixture', total: 1, episodes: [{ id: '9' }] }) }, {}, os.tmpdir());
  const whole = { videoId: '9', cacheKey: '9:0.000', offset: 0, complete: true, expiresAt: Date.now() + 120_000, leases: new Map(), cancel() {} };
  playback.mobile.jobs.add(whole); playback.mobile.entries.set(whole.cacheKey, whole);
  const prepared = [];
  playback.mobile.sourceMetadata = async () => ({ expectedDuration: 12 });
  playback.mobile.prepare = async (videoId, options) => {
    prepared.push(options.offset);
    const job = { videoId, offset: options.offset, leases: new Map(), expiresAt: Date.now() + 120_000, cancel() {} };
    playback.mobile.jobs.add(job); return job;
  };
  try {
    assert.equal(playback.mobile.finished('9'), whole);
    assert.equal(await playback.resolveResumeHLS('1', 1, 5), null);
    assert.deepEqual(prepared, [], 'the seekable whole file serves the resume; no second conversion');
    // 快过期（prepare 也不会复用）或还没转完的，照常从进度处转
    whole.expiresAt = Date.now() + 30_000;
    assert.equal((await playback.resolveResumeHLS('1', 1, 5)).job.offset, 5);
    whole.expiresAt = Date.now() + 120_000; whole.complete = false;
    assert.equal((await playback.resolveResumeHLS('1', 1, 6)).job.offset, 6);
    assert.deepEqual(prepared, [5, 6]);
  } finally { await playback.close(); }
});

test('seek positions reject invalid values and leave a valid tail at the end', () => {
  for (const value of [-1, 13, NaN, Infinity, '9', null]) assert.throws(() => seekPosition(value, 12), { code: 'INVALID_POSITION' });
  assert.deepEqual(seekPosition(9, 12), { position: 9, offset: 9 });
  assert.deepEqual(seekPosition(12, 12), { position: 11.92, offset: 10 });
});

test('direct MP4 fallback seeks without requesting an App source', async () => {
  const playback = new Playback({}, {}, os.tmpdir());
  const clientId = '11111111-2222-4333-8444-555555555555';
  const entry = { token: 'direct', duration: 12.08, expectedDuration: 12, expiresAt: Date.now() + 60000 };
  try {
    playback.begin(entry, clientId);
    const result = await playback.seek({ session: entry.token, clientId, sequence: 1, position: 9 });
    assert.equal(result.format, 'mp4'); assert.equal(result.position, 9); assert.equal(result.offset, 0);
    assert.equal(result.duration, 12, 'timeline uses official duration despite muxing timestamp padding');
    assert.equal((await playback.seek({ session: entry.token, clientId, sequence: 2, position: result.duration })).position, 11.92);
    assert.equal(playback.mobile.jobs.size, 0);
  } finally { await playback.close(); }
});

test('seeking into unprocessed encrypted media lands in the correct scene with aligned audio', { timeout: 40_000 }, async () => {
  const { root, data } = await fixture({ colors: true }); let modelCalls = 0;
  const playback = new Playback({ detail: async () => ({ title: 'fixture', total: 1, episodes: [{ id: '1' }] }) }, {}, root);
  await playback.mobile.close();
  playback.mobile = new MobilePlayback(root, { models: { resolve: async id => { modelCalls++; return models().resolve(id); } }, bridge: new SourceBridge(mediaFetcher(data, { wait: 20 })) });
  const clientId = '11111111-2222-4333-8444-555555555555';
  try {
    const initial = await playback.resolve('1', 1); playback.begin(initial, clientId);
    assert.ok(initial.job.availableDuration < 9); assert.equal(initial.job.complete, false);
    const result = await playback.seek({ session: initial.token, clientId, sequence: 1, position: 9 });
    assert.equal(result.position, 9); assert.equal(result.offset, 9); assert.equal(result.duration, 12); assert.equal(result.verification, 'not_checked');
    const job = playback.sessions.get(clientId).active.job; await job.done;
    assert.equal(initial.job.complete, false); assert.equal(modelCalls, 1);
    const frame = await run('ffmpeg', ['-v','error','-i',job.file,'-frames:v','1','-vf','crop=32:32:0:0,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'], { encoding: 'buffer' });
    assert.ok(frame.stdout[1] > 80 && frame.stdout[0] < 25 && frame.stdout[2] < 25, 'must show the green final scene, not the red opening');
    const metadata = JSON.parse((await run('ffprobe', ['-v','error','-show_entries','stream=codec_type,start_time','-of','json',job.file])).stdout);
    const starts = metadata.streams.map(stream => Number(stream.start_time)); assert.ok(Math.max(...starts)-Math.min(...starts) < 0.1);
    assert.equal((await decodeMedia(job.file, job, 3, { local: true })).classification, 'complete');
    await assert.rejects(playback.seek({ session: initial.token, clientId, sequence: 1, position: 4 }), { code: 'SEEK_SUPERSEDED' });
    const old = playback.seek({ session: initial.token, clientId, sequence: 2, position: 5 }).catch(error => error);
    await sleep(100);
    const latest = await playback.seek({ session: initial.token, clientId, sequence: 3, position: 5 });
    assert.equal((await old).code, 'SEEK_SUPERSEDED'); assert.equal(latest.sequence, 3);
    assert.equal(playback.sessions.get(clientId).active.job.offset, 5);
    playback.release(initial.token, clientId); assert.equal(playback.sessions.has(clientId), false);
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});

test('preloading the next encrypted episode transfers its existing job and keeps seek working', { timeout: 30_000 }, async () => {
  const { root, data } = await fixture(); const requested = [];
  const playback = new Playback({ detail: async () => ({ title: 'fixture', total: 2, episodes: [{ id: '1' }, { id: '2' }] }) }, {}, root);
  await playback.mobile.close();
  playback.mobile = new MobilePlayback(root, { models: { resolve: id => { requested.push(id); return models().resolve(id); } }, bridge: new SourceBridge(mediaFetcher(data, { wait: 10 })) });
  const parentClientId = '11111111-2222-4333-8444-555555555555', clientId = '22222222-2222-4333-8444-555555555555';
  try {
    const current = await playback.resolve('1', 1); playback.begin(current, parentClientId);
    assert.equal(current.job.complete, false);
    await assert.rejects(playback.preload({ session: current.token, parentClientId, clientId }), { code: 'APP_BUSY' });
    assert.deepEqual(requested, ['1']);
    await playback.mobile.worker.done;
    const next = await playback.preload({ session: current.token, parentClientId, clientId });
    const warmJob = playback.sessions.get(clientId).active.job;
    assert.equal(next.number, 2); assert.equal(next.verification, 'not_checked'); assert.deepEqual(requested, ['1', '2']);
    assert.equal(current.job.error, undefined); assert.ok(current.job.leases.has(parentClientId));
    assert.equal(playback.mobile.worker.job, warmJob);
    const adopted = playback.adopt({ parentClientId, clientId, session: next.session });
    assert.equal(adopted.media, next.media); playback.release(current.token, parentClientId);
    assert.equal(playback.mobile.worker.priority, true);
    assert.equal(playback.mobile.available(warmJob), true); assert.ok(warmJob.leases.has(clientId));
    await warmJob.done;
    assert.equal((await decodeMedia(warmJob.file, warmJob, 12, { local: true })).classification, 'complete');
    const seek = await playback.seek({ session: next.session, clientId, sequence: 1, position: 9 });
    assert.equal(seek.cached, true); assert.equal(seek.position, 9);
    assert.deepEqual(await playback.preload({ session: next.session, parentClientId: clientId, clientId: parentClientId }), { next: null });
    assert.deepEqual(requested, ['1', '2'], 'last episode must not preload episode one or another title');
  } finally { await playback.close(); await rm(root, { recursive: true, force: true }); }
});
